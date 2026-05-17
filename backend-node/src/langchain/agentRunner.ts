import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
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

export type LangChainAgentRunResult = {
  outputText: string;
  toolCallCount: number;
};

type RunLangChainAgentStreamOptions = {
  requestId: string;
  message: string;
  systemPrompt: string | undefined;
  history: NormalizedChatHistoryItem[];
  /**
   * Phase 5.2 加这个字段是为了"接口对齐":
   * 路由层会把 threadId 同时传给 Phase 3 和 Phase 4,所以两边必须有这个参数。
   *
   * 但 Phase 3(createAgent)路径**不接入 checkpointer**——保留它作为
   * 无持久化的"快速回退路径"。这里只是收下 threadId 然后忽略,
   * 让上层调用接口统一。
   */
  threadId?: string;
  onToolEvent?: (event: ChatStreamEvent) => void;
  onDelta?: (delta: string) => void;
  shouldStop?: () => boolean;
};

/**
 * LangChain Agent Runner（第三阶段）。
 *
 * Agent 的“决定 -> 调工具 -> 再决定 -> 最终回答”循环交给 LangChain createAgent；
 * 我们这一层负责：
 *
 *   1. 构造系统提示词和历史消息
 *   2. 从 MCP 动态创建 LangChain tools
 *   3. 装上几个 “更标准” 的 middleware（重试、调用次数上限、工具次数上限）
 *   4. 用 streamEvents(v2) 把 token 一边产生一边推给上层（onDelta）
 *   5. 把工具事件、模型调用事件统一写进结构化日志
 *
 * 第二阶段时我们还在用 agent.invoke()，最终一次性发整段 delta；
 * 第三阶段切到 streamEvents，是为了把“token 级流式”这个体验拿回来——
 * 同时保留 LangChain 的工具循环、retry、观测点。
 */
export async function runLangChainAgentStream({
  requestId,
  message,
  systemPrompt,
  history,
  /**
   * Phase 3 路径忽略 threadId(我们故意不接 checkpointer)。
   * 加 void 是为了消除"声明了但没用"的 lint 警告。
   */
  threadId: _threadId,
  onToolEvent,
  onDelta,
  shouldStop,
}: RunLangChainAgentStreamOptions): Promise<LangChainAgentRunResult> {
  void _threadId;
  const startedAt = Date.now();
  let toolCallCount = 0;
  let outputText = "";
  //Agent Runner 加载工具(LangChain Phase 2 入口)
  const tools = await loadLangChainTools(requestId, {
    onToolEvent,
    onToolCompleted: () => {
      toolCallCount += 1;
    },
  });

  const agent = createAgent({
    /**
     * 关键变化：streaming: true。
     *
     * 第二阶段时这里写 false，因为 agent.invoke 模式下不需要流式，
     * 但代价是最终回答只能等模型完整返回后再一次性 onDelta。
     *
     * 第三阶段切到 streamEvents 之后，底层 ChatDeepSeek 必须开 streaming，
     * 这样 on_chat_model_stream 事件才会带 token chunks。
     *
     * disableThinking / disableParallelToolCalls 维持第二阶段的判断：
     * - thinking 模式要求下一轮 reasoning_content 回传，当前 converter 不支持
     * - parallel tool calls 关掉是为了让日志和 iOS UI 一次只对齐一个工具
     * 
     * createAgent 是 LangChain 给你预设好的 ReAct Agent。ReAct = Reasoning + Acting,模式是:
     * Thought  → 我应该用哪个工具?
     * Action   → 调用 searchKnowledge(input: "@State")
     * Observation → 工具返回的结果
     * Thought  → 我现在有足够信息回答了
     * Final Answer → 给用户的回答
     * 
     * 这个循环你不用手写——createAgent 内部用一个状态机帮你跑。
     */
    model: createLangChainChatModel({// ← 谁来推理
      streaming: true,
      disableThinking: true,
      disableParallelToolCalls: true,
    }),
    tools,// ← 可用工具列表
    systemPrompt: buildAgentInstructions(systemPrompt),// ← 系统提示词
    middleware: buildAgentMiddleware(),// ← 中间件
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

  /**
   * streamEvents v2 返回一个 IterableReadableStream<StreamEvent>。
   * 我们订阅的事件类型主要有：
   *
   *   on_chat_model_start  → 模型一次调用开始
   *   on_chat_model_stream → 流式 token chunk（这就是要转发给 iOS 的 delta）
   *   on_chat_model_end    → 模型一次调用结束
   *   on_tool_start        → 工具一次执行开始
   *   on_tool_end          → 工具一次执行结束
   *
   * 工具相关的 SSE（tool_start / tool_done）我们仍然在 agentTools.ts 的
   * wrapper 内部自己发——因为那里能拿到 toolCallId、result.ok、duration。
   * streamEvents 的 on_tool_start/end 这里只用来写日志，避免重复发给 iOS。
   *
   * recursionLimit 是 Agent 的最后安全网：
   * “无论模型怎么决策，总迭代步数的上限”。
   */
  const eventStream = agent.streamEvents(
    { messages },
    {
      version: "v2",
      recursionLimit: agentRecursionLimit,
    }
  );

  /**
   * 用 wallclock 计算每次模型调用耗时——多个模型调用并发不可能发生，
   * 因为 createAgent 的图是串行的；不过为了健壮性，用 Map 按 runId 存。
   */
  const modelCallStarts = new Map<string, number>();

  try {
    /**
     * 把"用户消息 + 历史"塞进 Agent,Agent 开始自己跑;每跑一步就吐出一个事件,
     * 我们在 for await (const event of eventStream) 里接住每个事件
     */
    for await (const event of eventStream) {
      /**
       * iOS 端关闭连接后，server.ts 会把 clientClosed 置 true，
       * 这里通过 shouldStop 早退：
       * - 不再 onDelta（再发就 EPIPE）
       * - 不主动 abort agent，让它在 LangChain 内部自然走完
       *   （不会有任何 IO 副作用，最多浪费一次模型调用）
       *
       * 想真正 abort 可以加 AbortController，但学习项目里没必要。
       */
      if (shouldStop?.()) {
        logAgentInfo(requestId, "langchain_agent", "client_closed_during_stream", {
          durationMs: getDurationMs(startedAt),
          outputCharCount: outputText.length,
        });
        break;
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
        // streamEvents 是 LangChain 提供的"看 Agent 内部发生了什么"的窗口。Agent 内部跑的时候,每经过一个阶段就吐一个事件。
        case "on_chat_model_stream": {//← 这里是 token! 
          /**
           * event.data.chunk 是 AIMessageChunk。
           * 内容可能是：
           *   - string："Hello world"
           *   - MessageContentComplex[]：[{ type: "text", text: "Hello" }, ...]
           *
           * messageContentToString 已经统一处理过两种格式。
           *
           * 在 Agent 决定调用工具的那一轮，content 通常是空字符串，
           * 真正的 tool_call 信息走在 chunk.tool_call_chunks 里——我们这里直接
           * 用 if (text) 过滤掉空 token，剩下的就只剩“给用户看的回答正文”。
           */
          //从 event.data.chunk.content 里取出文本
          const chunk = (event.data as { chunk?: AIMessageChunk } | undefined)?.chunk;
          const text = chunk ? messageContentToString(chunk.content) : "";

          if (text) {// ← 过滤空字符串
            outputText += text;

            if (!shouldStop?.()) {
              onDelta?.(text);// ← 触发回调链:onDelta → writeAgentSseEvent → SSE
            }
          }
          break;
        }

        case "on_chat_model_end": {
          const modelStartedAt = modelCallStarts.get(event.run_id);
          modelCallStarts.delete(event.run_id);

          logAgentInfo(requestId, "model_call", "completed", {
            runId: event.run_id,
            modelName: event.name,
            durationMs: modelStartedAt ? Date.now() - modelStartedAt : undefined,
          });
          break;
        }

        case "on_tool_start": {
          /**
           * 这条日志和 agentTools.ts 里发出的 SSE tool_start 是“同一件事”，
           * 但目标不同：
           * - SSE：给 iOS 实时展示进度
           * - 日志：给后端按 requestId grep 工具时间线
           *
           * 所以两边都保留，不算重复。
           */
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

  logAgentInfo(requestId, "langchain_agent", "completed", {
    durationMs: getDurationMs(startedAt),
    toolCallCount,
    outputCharCount: outputText.length,
  });

  return {
    outputText,
    toolCallCount,
  };
}

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

    /**
     * 和旧 Runner 一样：工具层不可用时不让整次请求失败。
     * LangChain Agent 会在无工具模式下继续生成普通回答。
     */
    logAgentInfo(requestId, "tool_setup", "fallback_to_no_tools", {
      durationMs: getDurationMs(loadToolsStartedAt),
      reason: "langchain_tools_load_failed",
    });

    return [];
  }
}

function buildAgentMiddleware() {
  /**
   * 第三阶段：用 LangChain 官方 middleware 把“边界保护”做得更标准。
   *
   * 我们装了三类 middleware：
   *
   * 1. modelRetryMiddleware
   *    一次 model 节点失败时按指数退避自动重试。
   *    onFailure:"continue" 表示——所有重试都失败后，不抛异常打断 Agent，
   *    而是把错误包成一条 AIMessage 让 Agent 自己处理（一般是直接回答用户）。
   *    这条 middleware 是“瞬时错误的安全网”，能挡住偶发 5xx / 429 / 网络抖动。
   *
   *    注意它和 ChatDeepSeek 自身的 maxRetries 是两层结构：
   *    - SDK 层 maxRetries：单次 fetch 重试（针对“一次 HTTP 调用失败”）
   *    - middleware 层：整个 model node 重试（针对“一次决策完整失败”）
   *
   * 2. modelCallLimitMiddleware
   *    硬性限制整次 Agent 最多调用模型多少次。
   *    它是成本兜底——recursionLimit 拦的是 Agent 总迭代步数，
   *    modelCallLimit 拦的是真金白银的模型调用次数。
   *    threadLimit 是“同一 thread/会话里的累计上限”；
   *    runLimit 是“本次 run 内的上限”。学习项目按 run 限就够。
   *
   * 3. toolCallLimitMiddleware (×3)
   *    第二阶段就有的逻辑：
   *    - searchKnowledge 一次足够，避免模型反复查同一个知识库
   *    - generateQuiz 同理
   *    - 全局再加一道，防止模型在所有工具之间反复横跳
   *    exitBehavior:"continue" 表示——达到上限后不抛错，
   *    只是不再允许调用，模型必须用现有信息回答。
   *
   * 把这些规则从 prompt 升级成 middleware 的好处是：
   * - prompt 是“软劝告”，模型可能不听
   * - middleware 是“硬约束”，达到上限就执行不了
   * - 行为可观测（middleware 自己会输出事件）
   */
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
