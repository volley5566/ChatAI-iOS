/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/agentGraph.ts — 手写 StateGraph 版 Agent 运行器
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   agent/agentRunner.ts → 这个文件 → langchain/agentGraphNodes.ts
 *
 * 当 USE_LANGGRAPH=true 时走这条路径(替代 Phase 3 的 createAgent)。
 * 函数签名跟 Phase 3 的 runLangChainAgentStream 完全一致,server.ts 无感切换。
 *
 * # 图的形状(经典 ReAct 循环)
 *
 *   ┌─────────┐
 *   │  START  │
 *   └────┬────┘
 *        ▼
 *   ┌─────────┐
 *   │  agent  │   ← 调模型,产生 AIMessage(可能含 tool_calls)
 *   └────┬────┘
 *        ▼
 *   ┌──────────────────┐
 *   │ shouldContinue?  │   ← 条件边:看上一条 AIMessage 有没有 tool_calls
 *   └──┬───────────────┘
 *      │             │
 *  有 tool_calls   没有
 *      ▼             ▼
 *   ┌───────┐      ┌─────┐
 *   │ tools │      │ END │
 *   └───┬───┘      └─────┘
 *       └──────→ agent (循环)
 *
 * # 时间线示意
 *   t0  START
 *   t1  agent → 模型决定调 searchKnowledge
 *   t2  shouldContinue → "tools"
 *   t3  tools → 拿到工具结果
 *   t4  回到 agent
 *   t5  agent → 模型基于工具结果生成最终回答
 *   t6  shouldContinue → END
 */

import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { ClientTool } from "@langchain/core/tools";
import { Command, END, START, StateGraph } from "@langchain/langgraph";
import { buildAgentInstructions } from "../chat/prompts";
import type { ToolApprovalResponse } from "./agentGraphNodes";
import {
  getDurationMs,
  logAgentError,
  logAgentInfo,
} from "../agent/agentObservability";
import { agentRecursionLimit } from "../config/env";
import type {
  ChatStreamEvent,
  NormalizedChatHistoryItem,
  PendingToolApproval,
} from "../shared/types";
import { createLangChainAgentTools } from "./agentTools";
import { AgentState } from "./agentGraphState";
import {
  createAgentNode,
  createEvaluateAnswerNode,
  createToolNode,
  extractFinalAssistantText,
  shouldContinue,
} from "./agentGraphNodes";
import { messageContentToString } from "./chatPrompt";
import { getSqliteCheckpointer } from "../db/sqliteCheckpointer";

// ─── 类型定义 ──────────────────────────────────────────────────

/**
 * 一次 Agent 调用的 token 用量(ReAct 循环里所有模型调用的累加)。
 * 来源:LangChain 在 on_chat_model_end 事件的 AIMessage.usage_metadata。
 */
export type TokenUsage = {
  /** 所有模型调用的 input token 总和 */
  promptTokens: number;
  /** 所有模型调用的 output token 总和 */
  completionTokens: number;
  /** promptTokens + completionTokens */
  totalTokens: number;
};

export type LangGraphAgentRunResult = {
  outputText: string;
  toolCallCount: number;
  /**
   * LangSmith 根 run UUID。
   * 来源:streamEvents 第一个 on_chain_start 事件的 run_id。
   * server.ts 把它塞进 SSE done payload,iOS 用它调 /api/feedback。
   * 可能 undefined:stream 没产出任何事件就异常(基本不会发生)。
   */
  rootRunId: string | undefined;
  /** 本次 Agent 调用消耗的 token 总量 */
  usage: TokenUsage;
  /**
   * HITL: 如果图被 interrupt() 挂起,这里携带挂起的 tool_call 信息。
   * server.ts 收到后把它塞进 SSE done.pending,iOS 收到后展示审批卡片。
   * undefined 表示图正常跑完,没有挂起。
   *
   * 注意:只有 threadId 路径才可能 pending(无 checkpointer 无法恢复)。
   */
  pending?: PendingToolApproval;
};

type RunLangGraphAgentStreamOptions = {
  requestId: string;
  message: string;
  systemPrompt: string | undefined;
  history: NormalizedChatHistoryItem[];
  /**
   * HITL 续跑参数。
   *
   * 不传(undefined)→ 正常首跑:把 message + history 包成 initialMessages 喂图
   * 传了        → 续跑:streamEvents 第一个参数改用 new Command({ resume })
   *                  忽略 message / history(图自动从 checkpointer 加载上次的 state)
   *
   * 只在 threadId 路径下有意义(没有 checkpointer 无法恢复)。
   */
  resumePayload?: ToolApprovalResponse;
  /**
   * 对话 ID。
   *
   * 传了 → 启用 checkpointer 持久化:
   *   - 从 SQLite 加载已有 state(没有就当新对话)
   *   - 跑完图后把新 state 存回数据库
   *
   * 不传 → 无持久化模式,图跑完 state 立即丢弃
   * (兼容老版本 iOS,server.ts 不传 thread_id 时走这条)
   */
  threadId?: string;
  onToolEvent?: (event: ChatStreamEvent) => void;
  onDelta?: (delta: string) => void;
  shouldStop?: () => boolean;
};

// ─── 入口函数 ─────────────────────────────────────────────────

/**
 * Phase 4 入口函数,签名和 Phase 3 的 runLangChainAgentStream 完全一致。
 * server.ts 不需要改,底层从 createAgent 换成手写 StateGraph。
 */
export async function runLangGraphAgentStream({
  requestId,
  message,
  systemPrompt,
  history,
  threadId,
  resumePayload,
  onToolEvent,
  onDelta,
  shouldStop,
}: RunLangGraphAgentStreamOptions): Promise<LangGraphAgentRunResult> {
  // HITL 续跑必须有 threadId(没有 checkpointer 就没东西可恢复)
  if (resumePayload && !threadId) {
    throw new Error(
      "HITL resume requires a thread_id (no checkpointer means no state to resume)."
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
  // createLangChainAgentTools 把"MCP 工具 → LangChain Tool"的桥接和
  // SSE 事件发送都做了,Phase 4 直接复用,不重写这一层。
  const tools = await loadLangGraphTools(requestId, {
    onToolEvent,
    onToolCompleted: () => {
      toolCallCount += 1;
    },
  });

  // ─── 第二步:构建图 ────────────────────────────────────────
  //
  // StateGraph 的 API 链式调用:
  //   new StateGraph(stateSchema)
  //     .addNode("name", nodeFn)
  //     .addEdge(fromName, toName)
  //     .addConditionalEdges(fromName, conditionFn)
  //     .compile()
  //
  // compile() 返回 CompiledStateGraph,有 invoke / stream / streamEvents 方法。
  const agentNode = createAgentNode({
    requestId,
    systemPrompt: buildAgentInstructions(systemPrompt),
    tools,
    onModelCallStart: (runId) => {
      logAgentInfo(requestId, "model_call", "started", {
        runId,
        source: "agentNode",
      });
    },
    onModelCallEnd: (runId) => {
      logAgentInfo(requestId, "model_call", "completed", {
        runId,
        source: "agentNode",
      });
    },
  });

  const toolNode = createToolNode({
    requestId,
    tools,
    // 把 onToolEvent 透传给 toolNode,让 HITL 在 interrupt() 之前能发 tool_pending SSE
    onToolEvent,
  });

  // Phase 9 #6 — 独立的 evaluateAnswer 节点,绕过 MCP 直连子图
  // 详见 agentGraphNodes.ts:createEvaluateAnswerNode 的注释
  const evaluateAnswerNode = createEvaluateAnswerNode({
    requestId,
    onToolEvent,
  });

  /**
   * checkpointer 决定图要不要做"对话持久化":
   *   - 有 threadId → 用 SqliteCheckpointer,每次节点跑完自动存 state
   *   - 无 threadId → undefined,跑完即丢
   *
   * 注意:checkpointer 是图编译期决定的,**编译后不能改**。
   */
  const checkpointer = threadId ? getSqliteCheckpointer() : undefined;

  /**
   * # 图的拓扑(Phase 9 #6 后)
   *
   *   START
   *     ↓
   *   agent ─── shouldContinue ──┬─→ "evaluateAnswer" ─→ agent (loop)
   *                              ├─→ "tools"           ─→ agent (loop)
   *                              └─→ END
   *
   *   evaluateAnswer 节点内部直接 invoke 子图(EvaluateAnswerState schema),
   *   不走 LangChain Tool wrapper / MCP server。
   *   tools 节点处理其它 3 个工具(searchKnowledge / generateQuiz /
   *   recommendNextTopic),仍然走 MCP 路径。
   */
  const graph = new StateGraph(AgentState)
    // addNode 把节点函数注册到图里,起一个名字(后面 addEdge 要用)。
    // 名字是字符串,但 LangGraph 类型系统会收集起来,addEdge 时类型检查
    // 会报"不存在的节点名"——LangGraph 类型安全的亮点之一。
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("evaluateAnswer", evaluateAnswerNode)
    // addEdge 加"必然走"的边:START → agent
    .addEdge(START, "agent")
    // addConditionalEdges:shouldContinue 返回节点名,框架按名查找下一个节点。
    // 第三个参数是"可能的返回值列表",帮 LangGraph 做静态分析 + 画图 + 类型推导。
    // Phase 9 #6 加了 "evaluateAnswer" 这个分支(原来只有 "tools" / END)。
    .addConditionalEdges("agent", shouldContinue, [
      "tools",
      "evaluateAnswer",
      END,
    ])
    // 两条工具路径跑完都回 agent 让模型基于结果继续推理
    .addEdge("tools", "agent")
    .addEdge("evaluateAnswer", "agent")
    // compile 编译成可运行的图,编译期检查:
    //   - 所有 edge 端点都已 addNode
    //   - 没有死节点
    //   - START 必须能到 END
    .compile({ checkpointer });

  // ─── 第三步:构造 streamEvents 入参 + 调用 ────────────────────
  //
  // streamEvents 的第一个参数有三种合法形态,按互斥优先级判断:
  //
  // ┌──────────────────────┬────────────────────────────────────────────────────┐
  // │ 1. HITL 续跑          │  new Command({ resume: resumePayload })            │
  // │  (有 resumePayload)   │  图从挂起的 toolNode **接着跑**,                  │
  // │                       │  resumePayload 会成为 interrupt() 的返回值。       │
  // │                       │  state 自动从 checkpointer 加载,                  │
  // │                       │  message / history 字段被忽略。                    │
  // ├──────────────────────┼────────────────────────────────────────────────────┤
  // │ 2. 普通持久化首跑      │  { messages: [new HumanMessage(message)] }         │
  // │  (有 threadId         │  历史已经在 checkpointer 里,只追加新消息,        │
  // │   无 resumePayload)   │  messagesStateReducer 会自动 append。              │
  // │                       │  如果再传一遍 history 会重复!                     │
  // ├──────────────────────┼────────────────────────────────────────────────────┤
  // │ 3. 无持久化           │  { messages: [...history, new HumanMessage] }      │
  // │  (无 threadId)        │  state 从空 [] 开始,history 必须一起塞进去,      │
  // │                       │  否则模型看不到之前的对话。                        │
  // └──────────────────────┴────────────────────────────────────────────────────┘
  //
  // ## 为什么分两个 if 分支调 streamEvents,不是统一构造 graphInput 变量?
  //
  // 写成
  //   const input: {messages} | Command = ...
  //   streamEvents(input, options)
  // 会让 TS 在重载里选错(把 Command 联合类型误判成 v3 二进制流),
  // 编译报错。分支调用让类型推导走对路径。
  //
  // ## configurable.thread_id 是什么
  //
  // LangGraph 给 RunnableConfig 留的"特殊配置入口"。
  // 所有 checkpointer 都靠这个字段区分不同对话:
  //   thread_id = "abc" → 读 abc 的 state、写回 abc 的 state
  //   thread_id 不传    → 不走持久化,state 跑完即丢
  //
  // ## metadata + tags
  //
  // 纯给 LangSmith trace 加业务标签 — 网页上能按 metadata 过滤,按 tag 筛选。
  // 没接 LangSmith 也不会出错,LangChain 静默忽略。
  const streamConfig = {
    version: "v2" as const,
    recursionLimit: agentRecursionLimit,
    configurable: threadId ? { thread_id: threadId } : undefined,
    metadata: {
      request_id: requestId,
      thread_id: threadId ?? null,
      route: resumePayload ? "/api/threads/:id/resume" : "/api/agent/stream",
      runner: "langgraph-stategraph",
      use_langgraph: true,
      history_count: history.length,
      hitl_resume: Boolean(resumePayload),
    },
    tags: [
      "agent",
      "phase-4",
      threadId ? "persistent" : "stateless",
      ...(resumePayload ? ["hitl-resume"] : []),
    ],
  };

  const initialMessages = resumePayload
    ? []
    : threadId
      ? [new HumanMessage(message)]
      : buildInitialMessages(message, history);

  logAgentInfo(requestId, "langgraph_agent", "started", {
    mode: resumePayload ? "resume" : "fresh",
    messageCount: initialMessages.length,
    toolCount: tools.length,
    recursionLimit: agentRecursionLimit,
    threadId: threadId ?? "(none, no persistence)",
  });

  const eventStream = resumePayload
    ? graph.streamEvents(new Command({ resume: resumePayload }), streamConfig)
    : graph.streamEvents({ messages: initialMessages }, streamConfig);

  try {
    for await (const event of eventStream) {
      if (shouldStop?.()) {
        logAgentInfo(requestId, "langgraph_agent", "client_closed_during_stream", {
          durationMs: getDurationMs(startedAt),
          outputCharCount: outputText.length,
        });
        break;
      }

      // 捕根 run id:streamEvents 保证父 chain 的 on_chain_start
      // 一定先于子 chain 任何事件,所以第一个 on_chain_start 必然是
      // 整张图自己的启动事件,它的 run_id 就是 LangSmith 根 run。
      if (!rootRunId && event.event === "on_chain_start") {
        rootRunId = event.run_id;
      }

      switch (event.event) {
        case "on_chat_model_stream": {
          // event.data.chunk 是 AIMessageChunk(模型 .stream() 的每个 chunk)
          // 不管 chunk 来自哪个节点都会触发这个事件。
          const chunk = (event.data as { chunk?: AIMessageChunk } | undefined)
            ?.chunk;
          const text = chunk ? messageContentToString(chunk.content) : "";

          if (text) {
            outputText += text;
            if (!shouldStop?.()) {
              onDelta?.(text);
            }
          }
          break;
        }

        case "on_chat_model_end": {
          // 模型调用结束 → 从 AIMessage.usage_metadata 收集 token 用量。
          // usage_metadata = { input_tokens, output_tokens, total_tokens }
          // 数据来自 DeepSeek API 的 usage 字段,LangChain 只是转存。
          // ReAct 循环里可能有多次模型调用,每次都累加。
          const output = (event.data as { output?: AIMessageChunk } | undefined)?.output;
          const usageMeta = output?.usage_metadata;
          if (usageMeta) {
            promptTokens += usageMeta.input_tokens ?? 0;
            completionTokens += usageMeta.output_tokens ?? 0;
          }
          break;
        }

        case "on_tool_start": {
          // SSE tool_start 事件已经在 agentTools.ts wrapper 里发了,
          // 这里只写后端结构化日志(给 grep 用)。
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
    logAgentError(requestId, "langgraph_agent", "stream_failed", error, {
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

  /**
   * # HITL: 检测图是否被 interrupt() 挂起
   *
   * streamEvents 自然结束有两种可能:
   *   1. 图正常跑完(走到 END)
   *   2. 图被 interrupt() 挂起在某个节点
   *
   * 区分方式:graph.getState(config) 返回的 snapshot 有一个 `tasks` 数组,
   * 每个 task 可能带 interrupts(本次被挂起的 interrupt 调用)。只要有任何 task
   * 还有未消化的 interrupts,就说明图在等用户决策。
   *
   * 只在 threadId 路径才查:没有 checkpointer 的话 getState 无法定位 state。
   */
  let pending: PendingToolApproval | undefined;
  if (threadId) {
    try {
      const snapshot = await graph.getState({
        configurable: { thread_id: threadId },
      });
      const pendingInterrupt = snapshot.tasks
        ?.flatMap((task) => task.interrupts ?? [])
        .find((it) => it && typeof it.value === "object");

      if (pendingInterrupt) {
        const approvalReq = pendingInterrupt.value as {
          tool_call_id?: string;
          tool_name?: string;
          args?: Record<string, unknown>;
        };
        pending = {
          tool_call_id: approvalReq.tool_call_id ?? "",
          tool_name: approvalReq.tool_name ?? "",
          display_name: getDisplayNameForTool(approvalReq.tool_name ?? ""),
          args: approvalReq.args ?? {},
        };
      }
    } catch (error) {
      // getState 失败不应该让整次请求挂掉 — 业务降级为"图跑完了,没 pending"
      logAgentError(requestId, "langgraph_agent", "get_state_failed", error);
    }
  }

  logAgentInfo(requestId, "langgraph_agent", "completed", {
    durationMs: getDurationMs(startedAt),
    toolCallCount,
    outputCharCount: outputText.length,
    rootRunId: rootRunId ?? "(missing)",
    usage,
    pending: pending ? pending.tool_name : "(none)",
  });

  return {
    outputText,
    toolCallCount,
    rootRunId,
    usage,
    pending,
  };
}

// ─── HITL 查询接口 ────────────────────────────────────────────

/**
 * 查询某个 thread 当前是否有挂起的工具批准请求。
 *
 * 调用方: GET /api/threads/:id/pending 路由。
 * 典型场景: iOS 退出 app 又重新进,需要查"上次的对话是不是停在等审批"。
 *
 * # 关键技巧: dummy graph + getState
 *
 * 想读 checkpointer 里存的 state,LangGraph 要求你"拿一张编译过的图,
 * 调它的 .getState(config)"。但本接口只想读 state,**不想真的跑图**——
 * 真跑图需要重新加载 MCP tools / 编模型实例,代价大。
 *
 * 解决办法: 编一张"假图"(dummy graph),节点函数全是空操作。
 * 因为我们只调 getState 不调 invoke/stream,假节点永远不会被执行。
 *
 * ## 假图的两个硬约束
 *
 *   1. **state schema 必须和真图一致**(都用 AgentState)
 *      checkpointer 里的 state 是用 AgentState 的 channel reducers 序列化的,
 *      读出来要用同一套 schema 反序列化,否则报"unknown channel"错误。
 *
 *   2. **节点名必须和真图一致**(agent / tools)
 *      checkpointer 里的 `tasks` 用节点名标识"待执行的是谁"。
 *      如果假图里没有名叫 "tools" 的节点,task 名找不到对应节点定义,
 *      LangGraph 直接报"unreachable node"或类似的拒绝编译。
 *
 *   3. **拓扑也要对得上**(START → agent → tools → agent)
 *      LangGraph 编译期会做"所有节点必须可达"检查。如果假图里 tools 是
 *      孤儿节点(没人能到达),compile() 直接抛错。
 *      所以即使节点函数是空的,边的连法也要跟真图一致。
 *
 * # 怎么从 snapshot 里读出"挂起"信息
 *
 * snapshot.tasks 数组里的每个 task 有 `interrupts` 字段:
 *   - 空数组 → 这个 task 还没跑,但没被 interrupt 拦下
 *   - 非空 → task 跑到一半被 interrupt(payload) 挂住,payload 在这里
 *
 * 我们只挂了一种 interrupt(在 toolNode 里),所以从所有 task 的所有
 * interrupts 里找第一个 value 是对象的就行。
 *
 * @returns 有挂起 → PendingToolApproval;没有 / thread 不存在 → null
 */
export async function getPendingApprovalForThread(
  threadId: string
): Promise<PendingToolApproval | null> {
  const checkpointer = getSqliteCheckpointer();

  // 最小图:节点函数不会被执行,所以用 no-op 就行。
  // 关键点是**拓扑结构必须和真图一致**(节点名 agent/tools + 条件边),
  // 否则:
  //   1. LangGraph 编译期校验会拒绝(unreachable nodes)
  //   2. checkpoint 里记录的 task 名字("tools")在这里找不到对应节点
  // 节点函数体可以是空的,因为我们只调 getState,不调 invoke/stream。
  // Phase 9 #6 — dummy graph 拓扑要和真图保持一致(包括 evaluateAnswer 节点),
  // 否则 checkpointer 里记录的 task 名 "evaluateAnswer" 在这里找不到对应节点,
  // LangGraph 编译期会拒绝。
  const dummyGraph = new StateGraph(AgentState)
    .addNode("agent", async () => ({}))
    .addNode("tools", async () => ({}))
    .addNode("evaluateAnswer", async () => ({}))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", () => END, ["tools", "evaluateAnswer", END])
    .addEdge("tools", "agent")
    .addEdge("evaluateAnswer", "agent")
    .compile({ checkpointer });

  const snapshot = await dummyGraph.getState({
    configurable: { thread_id: threadId },
  });

  // tasks 数组在"图刚 interrupt 还没 resume"时有内容;正常跑完后是空
  const pendingInterrupt = snapshot.tasks
    ?.flatMap((task) => task.interrupts ?? [])
    .find((it) => it && typeof it.value === "object");

  if (!pendingInterrupt) {
    return null;
  }

  const approvalReq = pendingInterrupt.value as {
    tool_call_id?: string;
    tool_name?: string;
    args?: Record<string, unknown>;
  };

  return {
    tool_call_id: approvalReq.tool_call_id ?? "",
    tool_name: approvalReq.tool_name ?? "",
    display_name: getDisplayNameForTool(approvalReq.tool_name ?? ""),
    args: approvalReq.args ?? {},
  };
}

/**
 * 工具显示名映射 — 和 agent/agentTools.ts 的同名函数保持一致。
 * 这里独立一份是为了让 agentGraph.ts 不依赖 agent/ 目录。
 */
function getDisplayNameForTool(toolName: string): string {
  switch (toolName) {
    case "searchKnowledge":
      return "查询知识库";
    case "generateQuiz":
      return "生成练习题";
    case "evaluateAnswer":
      return "批改答题";
    case "recommendNextTopic":
      return "推荐学习方向";
    default:
      return toolName;
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────

/**
 * 把(history + 当前 message)转成 LangChain BaseMessage 数组。
 *
 * 注意:system prompt 不在这里加——agentNode 每次模型调用时才把 system
 * 拼到最前面,避免把 system 存进 state.messages(那会让 checkpointer
 * 持久化时多存一份冗余)。
 */
function buildInitialMessages(
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
 * 加载工具的小封装:
 *   - 成功 → 返回工具列表
 *   - 失败 → 写错误日志,返回 [](让 Agent 无工具模式继续跑)
 */
async function loadLangGraphTools(
  requestId: string,
  options: Parameters<typeof createLangChainAgentTools>[0]
): Promise<ClientTool[]> {
  const loadStart = Date.now();

  try {
    const tools = await createLangChainAgentTools(options);

    logAgentInfo(requestId, "tool_setup", "langgraph_tools_loaded", {
      durationMs: getDurationMs(loadStart),
      toolCount: tools.length,
      toolNames: tools.map((t) => t.name),
    });

    return tools;
  } catch (error) {
    logAgentError(requestId, "tool_setup", "langgraph_tools_load_failed", error, {
      durationMs: getDurationMs(loadStart),
    });

    logAgentInfo(requestId, "tool_setup", "fallback_to_no_tools", {
      durationMs: getDurationMs(loadStart),
      reason: "langgraph_tools_load_failed",
    });

    return [];
  }
}

/**
 * 调试用导出:让外部能拿到"最终回答文本"(给 agentDebug.ts 之类的脚本用)。
 * Phase 4 内部已经在 streamEvents 循环里累积 outputText 了,
 * 这个导出主要是 API 完整性(和 Phase 3 对齐)。
 */
export { extractFinalAssistantText };
