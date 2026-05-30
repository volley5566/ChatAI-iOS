/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/agentRunner.ts — Phase 3 createAgent 版 Agent 运行器
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   agent/agentRunner.ts → 这个文件 → LangChain createAgent + middleware
 *
 * 当 USE_LANGGRAPH=false(默认)时走这条路径。
 *
 * # 这一层做什么
 *   1. 构造系统提示词和历史消息(BaseMessage[])
 *   2. 从 MCP 动态创建 LangChain tools
 *   3. 装上几个标准 middleware:重试、模型调用次数上限、工具调用次数上限
 *   4. 用 streamEvents(v2) 把 token 一边产生一边推给上层(onDelta)
 *   5. 统一写结构化日志 + 收集 token 用量
 *
 * # createAgent vs 手写 StateGraph(agentGraph.ts)
 *   createAgent 是 LangChain 给你预设好的 ReAct Agent,内部已经把
 *   "Thought → Action → Observation → Final Answer" 循环跑好了,你不用管。
 *   agentGraph.ts 把这个循环用 StateGraph 自己拼一遍,更灵活,但也更复杂。
 *
 * # 这条路径不接 checkpointer
 *   threadId 参数收下后忽略,保留作为"无持久化的快速回退路径"。
 *   想要对话持久化,把 USE_LANGGRAPH 切到 true 走 agentGraph.ts。
 */

import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { TokenUsage } from "./agentGraph";
import type { PendingToolApproval } from "../shared/types";
import type { ToolApprovalResponse } from "./agentGraphNodes";
import {
  createAgent,
  modelCallLimitMiddleware,
  modelRetryMiddleware,
  toolCallLimitMiddleware,
} from "langchain";
import type { ClientTool } from "@langchain/core/tools";
import { buildAgentInstructions } from "../chat/prompts";
import {
  getDurationMs,
  logAgentError,
  logAgentInfo,
} from "../agent/agentObservability";
import {
  agentModelCallLimit,
  agentModelRetryMaxAttempts,
  agentRecursionLimit,
} from "../config/env";
import type {
  ChatStreamEvent,
  NormalizedChatHistoryItem,
} from "../shared/types";
import { createLangChainAgentTools } from "./agentTools";
import { createLangChainChatModel } from "./chatModel";
import { messageContentToString } from "./chatPrompt";

// ─── 类型定义 ──────────────────────────────────────────────────

export type LangChainAgentRunResult = {
  outputText: string;
  toolCallCount: number;
  /**
   * LangSmith 根 run UUID。详细说明见 agentGraph.ts 的同名字段。
   * 两条路径产出口径保持一致,server.ts 不用分别处理。
   */
  rootRunId: string | undefined;
  /** 本次 Agent 调用消耗的 token 总量(与 agentGraph.ts 同名字段对齐) */
  usage: TokenUsage;
  /**
   * HITL 挂起信息(与 LangGraphAgentRunResult 接口对齐)。
   * Phase 3 createAgent 路径**不接 checkpointer**,所以这里永远 undefined。
   * 想用 HITL 必须走 USE_LANGGRAPH=true。
   */
  pending?: PendingToolApproval;
};

type RunLangChainAgentStreamOptions = {
  requestId: string;
  message: string;
  systemPrompt: string | undefined;
  history: NormalizedChatHistoryItem[];
  /**
   * 接口对齐字段:路由层会把 threadId 同时传给 Phase 3 和 Phase 4,
   * 所以两边必须有这个参数。Phase 3 路径只是收下后忽略
   * (不接 checkpointer,作为无持久化的快速回退路径)。
   */
  threadId?: string;
  /**
   * HITL 续跑参数(接口对齐字段)。
   * Phase 3 createAgent **不支持 HITL** —— 收到非空值时直接抛错,
   * 提示调用方切到 USE_LANGGRAPH=true。
   */
  resumePayload?: ToolApprovalResponse;
  onToolEvent?: (event: ChatStreamEvent) => void;
  onDelta?: (delta: string) => void;
  shouldStop?: () => boolean;
};

// ─── 入口函数 ─────────────────────────────────────────────────

export async function runLangChainAgentStream({
  requestId,
  message,
  systemPrompt,
  history,
  // _ 前缀表示"声明了但故意不用",消除 lint 警告
  threadId: _threadId,
  resumePayload,
  onToolEvent,
  onDelta,
  shouldStop,
}: RunLangChainAgentStreamOptions): Promise<LangChainAgentRunResult> {
  void _threadId;

  // Phase 3 createAgent 没接 checkpointer,根本无法 resume 一个挂起的图。
  // 收到 resumePayload 直接报错,避免上层误以为续跑成功了。
  if (resumePayload) {
    throw new Error(
      "HITL resume is not supported on Phase 3 createAgent path. " +
        "Set USE_LANGGRAPH=true to use the LangGraph StateGraph path."
    );
  }
  const startedAt = Date.now();
  let toolCallCount = 0;
  let outputText = "";

  // 第一个 on_chain_start 事件的 run_id 就是 LangSmith trace 的根 run
  let rootRunId: string | undefined;

  // ReAct 循环里每次 on_chat_model_end 累加 token
  let promptTokens = 0;
  let completionTokens = 0;

  // ─── 第一步:加载 MCP 工具 ─────────────────────────────────
  const tools = await loadLangChainTools(requestId, {
    onToolEvent,
    onToolCompleted: () => {
      toolCallCount += 1;
    },
  });

  // ─── 第二步:创建 createAgent ──────────────────────────────
  //
  // createAgent 是 LangChain 预设的 ReAct Agent,循环是:
  //   Thought → 我应该用哪个工具?
  //   Action → 调用 searchKnowledge(...)
  //   Observation → 工具返回的结果
  //   Thought → 我现在有足够信息回答了
  //   Final Answer → 给用户的回答
  // 这个循环你不用手写,createAgent 内部用状态机帮你跑。
  const agent = createAgent({
    model: createLangChainChatModel({
      // streaming: true 是必须的——streamEvents 要靠模型流式吐 chunk
      // 才能触发 on_chat_model_stream 事件(给 iOS 实时打字效果)。
      streaming: true,
      // thinking 模式要求下一轮回传 reasoning_content,当前 converter 不支持
      disableThinking: true,
      // 关掉并行工具调用:让日志和 iOS UI 一次只对齐一个工具
      disableParallelToolCalls: true,
    }),
    tools,
    systemPrompt: buildAgentInstructions(systemPrompt),
    middleware: buildAgentMiddleware(),
    version: "v2",
  });

  const messages = buildAgentMessages(message, history);

  logAgentInfo(requestId, "langchain_agent", "started", {
    messageCount: messages.length,
    toolCount: tools.length,
    recursionLimit: agentRecursionLimit,
    modelRetryMaxAttempts: agentModelRetryMaxAttempts,
    modelCallLimit: agentModelCallLimit,
  });

  // ─── 第三步:streamEvents 跑 Agent,边产边推 ─────────────────
  //
  // 订阅的事件类型:
  //   on_chat_model_start  → 一次模型调用开始
  //   on_chat_model_stream → token chunk(转发给 iOS 的 delta)
  //   on_chat_model_end    → 一次模型调用结束(含 usage_metadata)
  //   on_tool_start        → 一次工具执行开始
  //   on_tool_end          → 一次工具执行结束
  //
  // 工具相关 SSE(tool_start / tool_done)在 agentTools.ts wrapper 内部发,
  // 因为那里能拿到 toolCallId、result.ok、duration。
  // streamEvents 这里的 on_tool_start/end 只用来写后端日志。
  //
  // 关于 withConfig:
  //   createAgent 的 streamEvents 类型签名不接受顶层 metadata/tags 字段,
  //   所以改用 withConfig 把 metadata/tags 挂在 Runnable 上——LangSmith
  //   trace 能拿到这些业务标签(便于网页上区分 Phase 3/4 路径)。
  const eventStream = agent
    .withConfig({
      metadata: {
        request_id: requestId,
        thread_id: _threadId ?? null,
        route: "/api/agent/stream",
        runner: "langchain-createagent",
        use_langgraph: false,
        history_count: history.length,
      },
      tags: ["agent", "phase-3", _threadId ? "persistent-mode" : "stateless"],
    })
    .streamEvents(
      { messages },
      {
        version: "v2",
        // Agent 总迭代步数的安全网,不管模型怎么决策都拦住
        recursionLimit: agentRecursionLimit,
      }
    );

  // 用 Map 按 runId 存模型调用起始时间,算 duration
  // (虽然 createAgent 的图是串行的,但留 Map 更健壮)
  const modelCallStarts = new Map<string, number>();

  try {
    // 用户消息 + 历史塞进 Agent,Agent 开始自己跑;每跑一步吐一个事件
    for await (const event of eventStream) {
      // iOS 端关闭连接后,server.ts 把 clientClosed 置 true,
      // 这里通过 shouldStop 早退:
      //   - 不再 onDelta(再发就 EPIPE)
      //   - 不主动 abort agent,让它在 LangChain 内部自然走完
      //     (无 IO 副作用,最多浪费一次模型调用)
      if (shouldStop?.()) {
        logAgentInfo(requestId, "langchain_agent", "client_closed_during_stream", {
          durationMs: getDurationMs(startedAt),
          outputCharCount: outputText.length,
        });
        break;
      }

      // 捕根 run id(见 agentGraph.ts 同名注释)
      if (!rootRunId && event.event === "on_chain_start") {
        rootRunId = event.run_id;
      }

      switch (event.event) {
        case "on_chat_model_start": {
          modelCallStarts.set(event.run_id, Date.now());
          logAgentInfo(requestId, "model_call", "started", {
            runId: event.run_id,
            modelName: event.name,
          });
          break;
        }

        case "on_chat_model_stream": {
          // event.data.chunk 是 AIMessageChunk,content 可能是:
          //   - string: "Hello world"
          //   - MessageContentComplex[]: [{ type: "text", text: "Hello" }, ...]
          // messageContentToString 统一处理两种格式。
          //
          // Agent 决定调用工具的那一轮,content 通常是空字符串,
          // 真正的 tool_call 信息走在 chunk.tool_call_chunks 里。
          // 用 if (text) 过滤掉空 token,剩下的就只剩"给用户看的回答正文"。
          const chunk = (event.data as { chunk?: AIMessageChunk } | undefined)?.chunk;
          const text = chunk ? messageContentToString(chunk.content) : "";

          if (text) {
            outputText += text;
            if (!shouldStop?.()) {
              // 触发回调链: onDelta → writeAgentSseEvent → SSE → iOS
              onDelta?.(text);
            }
          }
          break;
        }

        case "on_chat_model_end": {
          const modelStartedAt = modelCallStarts.get(event.run_id);
          modelCallStarts.delete(event.run_id);

          // 从 AIMessage.usage_metadata 收集 token 用量
          // (LangChain 把 DeepSeek API 的 usage 字段转存到了 AIMessage 上)
          const output = (event.data as { output?: AIMessageChunk } | undefined)?.output;
          const usageMeta = output?.usage_metadata;
          if (usageMeta) {
            promptTokens += usageMeta.input_tokens ?? 0;
            completionTokens += usageMeta.output_tokens ?? 0;
          }

          logAgentInfo(requestId, "model_call", "completed", {
            runId: event.run_id,
            modelName: event.name,
            durationMs: modelStartedAt ? Date.now() - modelStartedAt : undefined,
            usage: usageMeta
              ? { input: usageMeta.input_tokens, output: usageMeta.output_tokens }
              : undefined,
          });
          break;
        }

        case "on_tool_start": {
          // 这条日志和 agentTools.ts 里发出的 SSE tool_start 是"同一件事",
          // 但目标不同:
          //   - SSE → 给 iOS 实时展示进度
          //   - 日志 → 给后端按 requestId grep 工具时间线
          logAgentInfo(requestId, "tool_execution", "started", {
            runId: event.run_id,
            toolName: event.name,
          });
          break;
        }

        case "on_tool_end": {
          logAgentInfo(requestId, "tool_execution", "completed", {
            runId: event.run_id,
            toolName: event.name,
          });
          break;
        }

        default:
          break;
      }
    }
  } catch (error) {
    logAgentError(requestId, "langchain_agent", "stream_failed", error, {
      durationMs: getDurationMs(startedAt),
      outputCharCount: outputText.length,
    });
    throw error;
  }

  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };

  logAgentInfo(requestId, "langchain_agent", "completed", {
    durationMs: getDurationMs(startedAt),
    toolCallCount,
    outputCharCount: outputText.length,
    rootRunId: rootRunId ?? "(missing)",
    usage,
  });

  return {
    outputText,
    toolCallCount,
    rootRunId,
    usage,
  };
}

// ─── 辅助函数 ─────────────────────────────────────────────────

/** history + 当前 message → LangChain BaseMessage 数组 */
function buildAgentMessages(
  message: string,
  history: NormalizedChatHistoryItem[]
): BaseMessage[] {
  return [
    ...history.map((item): BaseMessage => {
      if (item.role === "user") {
        return new HumanMessage(item.content);
      }
      return new AIMessage(item.content);
    }),
    new HumanMessage(message),
  ];
}

/**
 * 加载工具,失败时不让整次请求挂掉。
 * LangChain Agent 在无工具模式下仍能生成普通回答(只是少了 RAG 能力)。
 */
async function loadLangChainTools(
  requestId: string,
  options: Parameters<typeof createLangChainAgentTools>[0]
): Promise<ClientTool[]> {
  const loadToolsStartedAt = Date.now();

  try {
    const tools = await createLangChainAgentTools(options);

    logAgentInfo(requestId, "tool_setup", "langchain_tools_loaded", {
      durationMs: getDurationMs(loadToolsStartedAt),
      toolCount: tools.length,
      toolNames: tools.map((tool) => tool.name),
    });

    return tools;
  } catch (error) {
    logAgentError(requestId, "tool_setup", "langchain_tools_load_failed", error, {
      durationMs: getDurationMs(loadToolsStartedAt),
    });

    logAgentInfo(requestId, "tool_setup", "fallback_to_no_tools", {
      durationMs: getDurationMs(loadToolsStartedAt),
      reason: "langchain_tools_load_failed",
    });

    return [];
  }
}

/**
 * 装配 LangChain 官方 middleware,把"边界保护"做得更标准。
 *
 * 1. modelRetryMiddleware
 *    一次 model 节点失败时按指数退避自动重试。
 *    onFailure: "continue" → 所有重试都失败也不抛异常,
 *    而是把错误包成 AIMessage 让 Agent 自己处理(一般是直接回答用户)。
 *    挡瞬时错误:5xx、429、网络抖动。
 *
 *    它和 ChatDeepSeek 自身的 maxRetries 是两层:
 *      - SDK 层 maxRetries → 单次 HTTP 调用失败时重试
 *      - middleware 层    → 整个 model node 失败时重试
 *
 * 2. modelCallLimitMiddleware
 *    硬性限制整次 Agent 最多调用模型多少次,成本兜底。
 *    跟 recursionLimit 的区别:
 *      - recursionLimit  → Agent 总迭代步数上限
 *      - modelCallLimit  → 真金白银的模型调用次数上限
 *
 * 3. toolCallLimitMiddleware(×3)
 *    - searchKnowledge 1 次: 避免反复查同一个知识库
 *    - generateQuiz    1 次: 同理
 *    - 全局再加 1 道:防止模型在所有工具之间反复横跳
 *    exitBehavior: "continue" → 达到上限后不抛错,只是不再允许调用,
 *    模型必须用现有信息回答。
 *
 * 为什么用 middleware 而不是 prompt 约束:
 *   - prompt 是"软劝告",模型可能不听
 *   - middleware 是"硬约束",达到上限就执行不了
 *   - 行为可观测(middleware 自己会输出事件)
 */
function buildAgentMiddleware() {
  return [
    modelRetryMiddleware({
      maxRetries: agentModelRetryMaxAttempts,
      onFailure: "continue",
    }),
    modelCallLimitMiddleware({
      runLimit: agentModelCallLimit,
      exitBehavior: "end",
    }),
    toolCallLimitMiddleware({
      toolName: "searchKnowledge",
      runLimit: 1,
      exitBehavior: "continue",
    }),
    toolCallLimitMiddleware({
      toolName: "generateQuiz",
      runLimit: 1,
      exitBehavior: "continue",
    }),
    toolCallLimitMiddleware({
      runLimit: 2,
      exitBehavior: "continue",
    }),
  ];
}
