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
import {
  createSummarizeNode,
  defaultKeepLastTurns,
  shouldSummarize,
} from "./summarizeNode";

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

  // Phase 11 #3 — 对话压缩节点
  // shouldSummarize 条件边会在 START 之后判断要不要先跑这个节点
  const summarizeNode = createSummarizeNode({
    requestId,
    keepLastTurns: defaultKeepLastTurns,
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
   * # 图的拓扑(Phase 11 #3 后)
   *
   *   START
   *     ↓
   *   shouldSummarize ──┬─→ "summarize" ─→ agent → ... (压缩老消息后进推理)
   *                     └─→ "agent"      ─→ ...        (回合数没够,直接推理)
   *
   *   agent ─── shouldContinue ──┬─→ "evaluateAnswer" ─→ agent (loop)
   *                              ├─→ "tools"           ─→ agent (loop)
   *                              └─→ END
   *
   * # 为什么 summarize 只在 START 之后判断,不在循环里
   *
   *   想象一次请求触发了 4 轮 ReAct 循环:
   *     agent → tools → agent → tools → agent → END
   *
   *   如果在每次 agent 之前都判断 summarize,就可能在 tools 调用和 agent
   *   消化结果之间插一刀,把 tool_calls / ToolMessage 的配对切散,
   *   模型会看到"无主的 ToolMessage"直接报 invalid_request_error。
   *
   *   把判断放在 START 之后,只对应"一个新用户请求开始"这个时刻,
   *   100% 安全(此时 state 永远停在"END 后的稳定态")。
   *
   * # HITL 兼容
   *
   *   HITL resume 时,LangGraph 从挂起的节点(toolNode/evaluateAnswerNode)
   *   重跑,**不经过 START**,所以 shouldSummarize 不会触发。
   *   这是正确的——resume 时图状态可能在"工具序列中间",此时压缩会乱套。
   */
  const graph = new StateGraph(AgentState)
    // addNode 把节点函数注册到图里,起一个名字(后面 addEdge 要用)。
    // 名字是字符串,但 LangGraph 类型系统会收集起来,addEdge 时类型检查
    // 会报"不存在的节点名"——LangGraph 类型安全的亮点之一。
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("evaluateAnswer", evaluateAnswerNode)
    .addNode("summarize", summarizeNode)
    // Phase 11 #3:START 不再直接 → agent,而是先走 shouldSummarize 条件边
    // 第三个参数 ["summarize", "agent"] 是"可能的返回值",LangGraph 编译期会校验
    .addConditionalEdges(START, shouldSummarize, ["summarize", "agent"])
    // 压缩完后必然进 agent(state.messages 已经短了 + state.summary 已经写好)
    .addEdge("summarize", "agent")
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
  const dummyGraph = getDummyStateGraph();

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

// ─── Dummy graph 工厂(共享给查询类接口用)──────────────────

/**
 * 模块级缓存的"假图" — 给只读 state 查询(getState / getStateHistory /
 * updateState 写另一个 thread 等)用,**不会被真的 invoke / stream 跑起来**。
 *
 * 为什么要这个东西?
 *   LangGraph 的 state 操作 API 都挂在 CompiledStateGraph 上,
 *   要读/写一个 thread 的 state,必须先 .compile() 一张图。
 *   但 .compile 完整真图需要加载 MCP 工具(每次调用都搞这一遍太重)。
 *
 * 这个假图:
 *   - state schema 和真图一致(都用 AgentState),否则反序列化报错
 *   - 节点名和真图一致(agent / tools / evaluateAnswer),否则 checkpointer
 *     里记录的 task name 在这里找不到对应节点
 *   - 节点函数体是空的,因为我们不会真的跑节点
 *   - 拓扑也要对得上,否则 compile 期校验会拒绝(unreachable node)
 *
 * 模块级 lazy 单例:第一次调时编一次,之后全部复用。
 */
let cachedDummyGraph: ReturnType<typeof buildDummyStateGraph> | undefined;

function getDummyStateGraph() {
  if (!cachedDummyGraph) {
    cachedDummyGraph = buildDummyStateGraph();
  }
  return cachedDummyGraph;
}

function buildDummyStateGraph() {
  // ⚠️ 节点 + 边的拓扑必须和真图(上面的 graph)完全一致,否则:
  //   - 节点名不一致 → checkpoint 里记录的 task 名字找不到对应节点,getState 报错
  //   - 边连法不一致 → compile() 期"unreachable node"检查失败
  // 我们读 state 不调 invoke/stream,节点函数体可以全是空 noop。
  return new StateGraph(AgentState)
    .addNode("agent", async () => ({}))
    .addNode("tools", async () => ({}))
    .addNode("evaluateAnswer", async () => ({}))
    .addNode("summarize", async () => ({}))
    // 假图条件边返回值无所谓,但 third arg 要列全 — LangGraph 编译期会校验
    .addConditionalEdges(START, () => END, ["summarize", "agent"])
    .addEdge("summarize", "agent")
    .addConditionalEdges("agent", () => END, ["tools", "evaluateAnswer", END])
    .addEdge("tools", "agent")
    .addEdge("evaluateAnswer", "agent")
    .compile({ checkpointer: getSqliteCheckpointer() });
}

// ─── Time-travel 接口(Phase 9 #7)────────────────────────────

/**
 * 一个 thread 的某个历史时刻的摘要,供 iOS 显示"分叉菜单"用。
 */
export type CheckpointSummary = {
  /** LangGraph 给每个 checkpoint 分配的不透明 id,fork 时原样回传 */
  checkpoint_id: string;
  /** 创建时间(ISO 8601) */
  created_at: string;
  /** 在 thread 的时间线上的位置(0 表示最早,1 表示其次,以此类推) */
  step: number;
  /** 这一刻 state 里有几条消息 */
  message_count: number;
  /** 给用户看的"这一刻 AI 说了啥"预览(最多 80 字符) */
  preview: string;
};

/**
 * 列出一个 thread 的所有"用户可分叉的时刻"。
 *
 * # 什么是"用户可分叉的时刻"
 *
 * LangGraph 每个节点跑完都存一个 checkpoint,一次"用户问 → 答"对话
 * 会产生 5-10 个 checkpoint(包括工具调用中间态)。对用户来说,中间态
 * (比如 "tools 节点刚跑完,agent 还没消化")没意义。
 *
 * 我们只暴露 "agentNode 跑完且 AI 消息没有 tool_calls" 的 checkpoint,
 * 即"模型说完最终答案、ReAct 循环回到 END 的那一刻"。
 *
 * 实现上:
 *   - graph.getStateHistory 返回**倒序**(最新在前)的 snapshot 迭代器
 *   - 过滤出 "最后一条消息是 AIMessage 且没有 tool_calls" 的 snapshot
 *   - 倒序变正序,给每个 snapshot 编 step(0, 1, 2, ...)
 *
 * @returns 按时间正序的 CheckpointSummary 数组;thread 不存在 → []
 */
export async function listCheckpointsForThread(
  threadId: string
): Promise<CheckpointSummary[]> {
  const dummyGraph = getDummyStateGraph();

  // getStateHistory 是个异步迭代器,逐个吐出 StateSnapshot(倒序)
  const allSnapshots: StateSnapshotShape[] = [];
  for await (const snap of dummyGraph.getStateHistory({
    configurable: { thread_id: threadId },
  })) {
    allSnapshots.push(snap as unknown as StateSnapshotShape);
  }

  // 过滤"完整对话时刻":最后一条消息是 AI 且没有 tool_calls
  const userFacing = allSnapshots.filter((snap) => {
    const messages = (snap.values as { messages?: unknown[] } | undefined)
      ?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return false;
    }
    const last = messages[messages.length - 1] as {
      // LangChain 序列化后的 AIMessage 大致长这样
      lc_id?: string[];
      tool_calls?: unknown[];
    };

    // 不是 AIMessage(检查 lc_id 路径) → 不算用户视角的完整时刻
    const isAi = last.lc_id?.includes("AIMessage");
    if (!isAi) return false;

    // AI 还在调工具 → 中间态,跳过
    if (Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
      return false;
    }
    return true;
  });

  // getStateHistory 是倒序(最新在前),我们要正序(最早在前)展示
  userFacing.reverse();

  return userFacing.map((snap, index) => ({
    checkpoint_id: extractCheckpointId(snap),
    created_at: snap.createdAt ?? new Date().toISOString(),
    step: index,
    message_count:
      (snap.values as { messages?: unknown[] } | undefined)?.messages
        ?.length ?? 0,
    preview: buildCheckpointPreview(snap),
  }));
}

/**
 * 从某个 checkpoint 分叉出一个新 thread。
 *
 * # 分叉语义
 *
 *   原 thread A:
 *     msg1 → msg2 → msg3 → msg4 → msg5    [checkpoints: c1, c2, c3, c4, c5]
 *                            ↑
 *                       用户选 c3 分叉
 *
 *   新 thread B 创建后:
 *     msg1 → msg2 → msg3                  [checkpoint: 复制自 c3]
 *     ↑ 用户后续发的新消息会接在这里
 *
 *   原 thread A **保持完整**,用户随时可以回去。
 *
 * # 实现要点
 *
 *   1. graph.getState({ thread_id: A, checkpoint_id: c3 }) 拿到 c3 时刻的 state
 *   2. 把那一刻的 messages 用 graph.updateState({ thread_id: B }, { messages })
 *      写到新 thread。LangGraph 会自动给新 thread 建第一个 checkpoint。
 *
 * # 为什么不能直接复制 SQLite 行
 *
 *   LangGraph 的 checkpoint 内部结构(channel_values / pending_writes / 父子链
 *   等)复杂且版本敏感,手动复制容易踩坑。走 LangGraph 的 updateState API,
 *   让框架自己处理序列化和元数据,稳。
 */
export async function forkThreadFromCheckpoint(options: {
  sourceThreadId: string;
  sourceCheckpointId: string;
  newThreadId: string;
}): Promise<{ messageCount: number }> {
  const dummyGraph = getDummyStateGraph();

  // 1. 拿到源 thread 在指定 checkpoint 的 state 快照
  //    configurable.checkpoint_id 让 LangGraph 取指定那一刻,而不是最新
  const snapshot = await dummyGraph.getState({
    configurable: {
      thread_id: options.sourceThreadId,
      checkpoint_id: options.sourceCheckpointId,
    },
  });

  const messages = (snapshot.values as { messages?: unknown[] } | undefined)
    ?.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(
      `Cannot fork: checkpoint ${options.sourceCheckpointId} has no messages.`
    );
  }

  // 2. 把消息写到新 thread。
  //    updateState 在新 thread 上是 no-op-then-create: LangGraph 看到新 thread
  //    没任何 state,会把这次 update 当成"创世 checkpoint"。
  await dummyGraph.updateState(
    { configurable: { thread_id: options.newThreadId } },
    { messages }
  );

  return { messageCount: messages.length };
}

// ─── Time-travel 内部 helper ──────────────────────────────────

/**
 * StateSnapshot 的实际形状(LangGraph 类型导出不完整,这里手写关键字段)。
 * 不 export — 只在本文件内部用。
 */
type StateSnapshotShape = {
  values: Record<string, unknown>;
  config?: { configurable?: { checkpoint_id?: string } };
  createdAt?: string;
  metadata?: { step?: number };
};

function extractCheckpointId(snap: StateSnapshotShape): string {
  return snap.config?.configurable?.checkpoint_id ?? "";
}

function buildCheckpointPreview(snap: StateSnapshotShape): string {
  const messages =
    (snap.values as { messages?: unknown[] } | undefined)?.messages ?? [];
  const last = messages[messages.length - 1] as
    | { content?: unknown }
    | undefined;
  if (!last) return "(空对话)";

  // content 可能是 string 也可能是 MessageContentComplex[]
  const text =
    typeof last.content === "string"
      ? last.content
      : Array.isArray(last.content)
      ? last.content
          .map((part: unknown) => {
            if (typeof part === "string") return part;
            if (
              part &&
              typeof part === "object" &&
              "text" in part &&
              typeof (part as { text: unknown }).text === "string"
            ) {
              return (part as { text: string }).text;
            }
            return "";
          })
          .join("")
      : "";

  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
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
