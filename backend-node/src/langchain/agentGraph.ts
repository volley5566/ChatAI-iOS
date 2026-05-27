import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { ClientTool } from "@langchain/core/tools";
import { END, START, StateGraph } from "@langchain/langgraph";
import { buildAgentInstructions } from "../chat/prompts";
import {
  getDurationMs,
  logAgentError,
  logAgentInfo,
} from "../agent/agentObservability";
import { agentRecursionLimit } from "../config/env";
import type {
  ChatStreamEvent,
  NormalizedChatHistoryItem,
} from "../shared/types";
import { createLangChainAgentTools } from "./agentTools";
import { AgentState } from "./agentGraphState";
import {
  createAgentNode,
  createToolNode,
  extractFinalAssistantText,
  shouldContinue,
} from "./agentGraphNodes";
import { messageContentToString } from "./chatPrompt";
import { getSqliteCheckpointer } from "../db/sqliteCheckpointer";

/**
 * Phase 4 — 把图拼起来。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这是 Phase 4 的入口文件,完整等价于 Phase 3 的 agentRunner.ts,
 * 但内部用手写的 StateGraph 取代了 createAgent 预设。
 * ─────────────────────────────────────────────────────────────────────
 *
 * # 图的形状
 *
 *   ┌──────────────┐
 *   │    START     │
 *   └──────┬───────┘
 *          │
 *          ▼
 *   ┌──────────────┐
 *   │  agent       │   ← agentNode:调模型,产生 AIMessage
 *   └──────┬───────┘
 *          │
 *          ▼
 *   ┌──────────────────┐
 *   │ shouldContinue?  │   ← 条件边:看上一条 AIMessage 有没有 tool_calls
 *   └──┬──────────────┬┘
 *      │              │
 *  有 tool_calls    没有 tool_calls
 *      │              │
 *      ▼              ▼
 *   ┌──────────┐    ┌─────┐
 *   │  tools   │    │ END │
 *   └────┬─────┘    └─────┘
 *        │
 *        └─────────→ agent (回到 agent 让模型基于工具结果继续推理)
 *
 *
 * # 这个图的 "时间线" 模拟
 *
 *   t0  START
 *   t1  agent 跑     → 模型决定调 searchKnowledge
 *   t2  shouldContinue → "tools"
 *   t3  tools 跑     → 拿到工具结果
 *   t4  回到 agent
 *   t5  agent 跑     → 模型基于工具结果生成最终回答
 *   t6  shouldContinue → END
 *   t7  END,图结束
 *
 * 整个循环就是经典的 ReAct(Reasoning + Acting)模式,只不过 Phase 3
 * createAgent 帮你预设好了,Phase 4 我们自己用 StateGraph 拼。
 */

export type LangGraphAgentRunResult = {
  outputText: string;
  toolCallCount: number;
};

type RunLangGraphAgentStreamOptions = {
  requestId: string;
  message: string;
  systemPrompt: string | undefined;
  history: NormalizedChatHistoryItem[];
  /**
   * Phase 5.2 新增 —— 对话 ID。
   *
   * 传了的话:
   *   - LangGraph 会用这个 id 在 checkpointer 里找已有的 state 快照
   *   - 没找到就当新对话开始
   *   - 跑完图会把新的 state 快照存回 checkpointer
   *
   * 不传(undefined):
   *   - 走"无持久化"模式
   *   - 图跑完 state 立刻丢弃,等价于 Phase 4 老行为
   *   - 这种模式仍然支持,主要为了让 server.ts 在 iOS 端没改造前不挂
   *
   * 一般 thread_id 由 server 层生成 UUID,iOS 端记着用。
   */
  threadId?: string;
  onToolEvent?: (event: ChatStreamEvent) => void;
  onDelta?: (delta: string) => void;
  shouldStop?: () => boolean;
};

/**
 * 入口函数,签名和 Phase 3 的 runLangChainAgentStream 完全一致——
 * server.ts 不需要修改,只是底层从 createAgent 换成手写 StateGraph。
 */
export async function runLangGraphAgentStream({
  requestId,
  message,
  systemPrompt,
  history,
  threadId,
  onToolEvent,
  onDelta,
  shouldStop,
}: RunLangGraphAgentStreamOptions): Promise<LangGraphAgentRunResult> {
  const startedAt = Date.now();
  let toolCallCount = 0;
  let outputText = "";

  /**
   * 第一步:加载工具(和 Phase 3 一样,从 MCP 拉)。
   *
   * 这一层我们故意保留 Phase 3 的 createLangChainAgentTools,
   * 因为它把"MCP 工具 → LangChain Tool"的桥接和 SSE 事件发送都做了,
   * Phase 4 不需要重写这一层。
   */
  const tools = await loadLangGraphTools(requestId, {
    onToolEvent,
    onToolCompleted: () => {
      toolCallCount += 1;
    },
  });

  /**
   * 第二步:构建图。
   *
   * StateGraph 的 API 链式调用:
   *   new StateGraph(stateSchema)
   *     .addNode("name", nodeFn)
   *     .addEdge(fromName, toName)
   *     .addConditionalEdges(fromName, conditionFn)
   *     .compile()
   *
   * compile() 返回一个 CompiledStateGraph,有 invoke / stream / streamEvents 方法。
   */
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
  });

  /**
   * Phase 5.2:有 threadId 就挂上 checkpointer,让 state 自动存档。
   *
   * 没 threadId(undefined)就走老行为(不持久化)——这条路径主要给
   * server.ts 在 iOS 端还没改造之前用的兼容路径。
   *
   * compile({ checkpointer }) 的效果:
   *   - 每次节点跑完,LangGraph 自动把更新后的 state 写到 checkpointer
   *   - 下次同 thread_id 调用 streamEvents 时,LangGraph 自动从 checkpointer
   *     读出上次的 state,接着往下跑
   *
   * 注意 checkpointer 是图编译期决定的,**编译后不能改**。所以这里要在
   * .compile() 调用时决定要不要传它。
   */
  const checkpointer = threadId ? getSqliteCheckpointer() : undefined;

  const graph = new StateGraph(AgentState)
    /**
     * .addNode 把节点函数注册到图里,起一个名字(后面 addEdge 要用)。
     * 名字是字符串,但 LangGraph 的类型系统会把它收集起来,addEdge 时类型检查
     * 会报错"不存在的节点名"——这是 LangGraph 类型安全的一个亮点。
     */
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    /**
     * .addEdge 加一条"必然走"的边。
     * START → agent:图启动后第一个节点就是 agent。
     */
    .addEdge(START, "agent")
    /**
     * .addConditionalEdges 加一条"根据 state 决定去哪"的边。
     * 第二个参数 shouldContinue 返回字符串,表示下一个节点的名字(或 END)。
     *
     * 第三个参数是"可能的返回值列表",帮助 LangGraph 做静态分析+生成更准的类型。
     * 不传也能跑,但推荐传——LangGraph 才能画图、推导类型。
     */
    .addConditionalEdges("agent", shouldContinue, ["tools", END])
    /**
     * tools 跑完一定回 agent,让模型基于工具结果继续推理。
     */
    .addEdge("tools", "agent")
    /**
     * compile 编译成可运行的图。
     * 编译期会做几项检查:
     *   - 所有 edge 的端点都已经 addNode
     *   - 没有"死节点"(没有任何边能到达的节点)
     *   - 没有缺路径(START 必须能到 END)
     *
     * checkpointer 是可选的:传了就启用持久化,不传就纯内存模式。
     */
    .compile({ checkpointer });

  /**
   * 第三步:准备初始 state(送进图的 messages 列表)。
   *
   * 这里要根据是否启用 checkpointer 分两种构造方式:
   *
   * - 有 threadId(走 checkpointer):
   *     state.messages 已经在数据库里,LangGraph 会自动加载。
   *     我们**只塞新消息**,LangGraph 用 messagesStateReducer 自动追加。
   *     如果再传一遍 history,会和数据库里已有的重复!
   *
   * - 没 threadId(无持久化):
   *     state 是空的(图启动时白板从默认值 [] 开始),
   *     所以要把 history + 当前消息一起塞进去。
   */
  const initialMessages = threadId
    ? [new HumanMessage(message)]
    : buildInitialMessages(message, history);

  logAgentInfo(requestId, "langgraph_agent", "started", {
    messageCount: initialMessages.length,
    toolCount: tools.length,
    recursionLimit: agentRecursionLimit,
    threadId: threadId ?? "(none, no persistence)",
  });

  /**
   * 第四步:用 streamEvents 跑图,token 一边产生一边推给 iOS。
   *
   * Phase 5.2 新增:传 configurable.thread_id。
   *   - LangGraph 会用它找 checkpointer 里已有的 state(如果有)
   *   - 跑完后把新 state 写回 checkpointer
   *
   * 没传 thread_id 也能跑(checkpointer 也是可选的),那就是纯内存模式。
   *
   * 注意 configurable 是 LangGraph 的"特殊配置入口",
   * thread_id 是其中**最常用的字段**——所有 checkpointer 都靠它隔离不同对话。
   */
  /**
   * Phase 10.1 — 给 LangSmith trace 加业务 metadata + tags。
   *
   * metadata 字段会出现在 LangSmith 网页 trace 详情的 "Metadata" 区,
   * 可以在 Project 列表页用 metadata 过滤(比如只看某个 thread 的所有 trace)。
   *
   * tags 是逗号分隔的字符串数组,LangSmith 网页可以按 tag 快速筛选——
   * 比如 ["agent", "phase-4"] 表示"这是 Phase 4 路径的 Agent 调用",
   * 区分 Phase 3 createAgent trace 时一眼可见。
   *
   * 这两个字段不影响 Agent 行为,纯粹是给 trace 加"业务标签",
   * 没接 LangSmith 也不会出错(LangChain 会静默忽略)。
   */
  const eventStream = graph.streamEvents(
    { messages: initialMessages },
    {
      version: "v2",
      recursionLimit: agentRecursionLimit,
      configurable: threadId ? { thread_id: threadId } : undefined,
      metadata: {
        request_id: requestId,
        thread_id: threadId ?? null,
        route: "/api/agent/stream",
        runner: "langgraph-stategraph",
        use_langgraph: true,
        history_count: history.length,
      },
      tags: [
        "agent",
        "phase-4",
        threadId ? "persistent" : "stateless",
      ],
    }
  );

  try {
    for await (const event of eventStream) {
      if (shouldStop?.()) {
        logAgentInfo(requestId, "langgraph_agent", "client_closed_during_stream", {
          durationMs: getDurationMs(startedAt),
          outputCharCount: outputText.length,
        });
        break;
      }

      switch (event.event) {
        case "on_chat_model_stream": {
          /**
           * event.data.chunk 是 AIMessageChunk,跟 Phase 3 完全一样。
           * 在 agentNode 内部模型 .stream() 的每个 chunk 都会触发这个事件,
           * 不管 chunk 在哪个节点里产生。
           */
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

        case "on_tool_start": {
          /**
           * SSE tool_start 已经在 agentTools.ts wrapper 里发了,
           * 这里只用来写后端结构化日志(给 grep 用)。
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
    logAgentError(requestId, "langgraph_agent", "stream_failed", error, {
      durationMs: getDurationMs(startedAt),
      outputCharCount: outputText.length,
    });
    throw error;
  }

  logAgentInfo(requestId, "langgraph_agent", "completed", {
    durationMs: getDurationMs(startedAt),
    toolCallCount,
    outputCharCount: outputText.length,
  });

  return {
    outputText,
    toolCallCount,
  };
}

/**
 * 把(message + history)转成 LangChain BaseMessage 数组。
 *
 * 和 Phase 3 buildAgentMessages 一模一样,只是搬过来不引入跨文件依赖。
 *
 * 注意 system prompt 不在这里加——agentNode 在每次模型调用时
 * 才把 system prompt 拼到最前面,避免把 system 存进 state.messages(
 * 那会让 checkpointer 持久化时多存一份冗余)。
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
 * 加载工具的小封装,逻辑跟 Phase 3 loadLangChainTools 一样:
 *  - 成功:返回工具列表
 *  - 失败:写错误日志,返回空数组(让 Agent 在无工具模式下继续)
 *
 * 这一层不需要 LangGraph 改造,createLangChainAgentTools 已经做得很好。
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
 * 一个调试用导出:让外部能拿到当前的"最终回答文本",
 * 主要给 agentDebug.ts 之类的脚本用。
 *
 * Phase 4 内部已经在 streamEvents 循环里累积 outputText 了,
 * 这个导出主要是为了 API 完整性(和 Phase 3 对齐)。
 */
export { extractFinalAssistantText };
