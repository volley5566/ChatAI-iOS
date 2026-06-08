import {
  AIMessage,
  AIMessageChunk,
  isAIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ClientTool } from "@langchain/core/tools";
import type { ToolCall } from "@langchain/core/messages/tool";
import { END, interrupt } from "@langchain/langgraph";
import {
  agentModelCallLimit,
  agentModelRetryMaxAttempts,
} from "../config/env";
import { logAgentInfo } from "../agent/agentObservability";
import type { ChatStreamEvent } from "../shared/types";
import type { AgentStateType, AgentStateUpdate } from "./agentGraphState";
import { createLangChainChatModel } from "./chatModel";
import { messageContentToString } from "./chatPrompt";
import { runEvaluateAnswerSubgraph } from "./subgraphs/evaluateAnswerGraph";

// ─── HITL (Human-in-the-Loop) 区 ──────────────────────────────
//
// # HITL 是什么
//   "AI 想调一个工具 → 暂停 → 问用户同不同意 → 用户同意才执行"
//   核心机制: LangGraph 的 interrupt() 把图"按暂停键",state 进 SQLite,
//   等外部用 Command(resume=...) 续跑。
//
// # 完整调用时序(从用户点发送到 iOS 看到工具结果)
//
//   t0  iOS 发 POST /api/agent/stream(message + thread_id)
//        │
//        ▼
//   t1  server.ts → runLangGraphAgentStream → streamEvents 跑图
//        │
//        ▼
//   t2  agentNode 调模型 → 模型决定 tool_call: generateQuiz
//        │
//        ▼
//   t3  toolNode 进入 → 发现工具在审核名单
//        ├─ 发 SSE tool_pending(让 iOS 弹卡片)
//        └─ 调 interrupt(approvalRequest) → 抛 GraphInterrupt
//        │
//        ▼
//   t4  图挂起,state 自动存进 checkpointer(SQLite)
//        streamEvents 自然结束,server 发 SSE done(pending: {...})
//        │
//        ▼
//   t5  iOS 收到 done.pending → ChatViewModel.pendingApproval = pending
//        → SwiftUI .sheet(item:) 弹审批卡片
//        │
//        ▼  (用户点[批准]或[拒绝])
//        ▼
//   t6  iOS 发 POST /api/threads/:id/resume {approved: true/false}
//        │
//        ▼
//   t7  server → runLangGraphAgentStream(resumePayload={approved}) →
//        streamEvents(new Command({resume: payload}))
//        │
//        ▼
//   t8  ★ LangGraph 从挂起的 toolNode **重新执行**(从节点头部),
//        但 interrupt() 这次不抛错,**同步返回 resume 值**
//        ⚠️  interrupt 之前的代码(包括 SSE tool_pending)会再执行一次!
//            iOS 端要按 tool_call_id 去重(VM.justResumedToolCallID)。
//        │
//        ▼
//   t9  approved=true → tool.invoke() 真正执行 → ToolMessage 入 state
//       approved=false → 塞 "user_rejected" ToolMessage,不调工具
//        │
//        ▼
//   t10 图回到 agentNode → 模型基于工具结果(或拒绝)生成最终回答
//        │
//        ▼
//   t11 SSE delta 流式吐文本 → done(pending: nil)→ iOS 收尾
//
// # 审核名单:哪些工具进 HITL
//   - LLM-as-tool(工具内部会调 DeepSeek): evaluateAnswer / generateQuiz / recommendNextTopic
//     → 有真实成本(token + 时间) + 输出会影响用户后续动作(评分/推荐)
//   - searchKnowledge: 纯本地 RAG,无成本无副作用 → 不审核

/**
 * HITL 审核名单 —— 工具名命中就 interrupt(),等用户点批准。
 */
const TOOLS_REQUIRING_APPROVAL = new Set<string>([
  "evaluateAnswer",
  "generateQuiz",
  "recommendNextTopic",
]);

/**
 * interrupt() 抛出的 payload 形状(iOS 通过 SSE tool_pending 收到这份数据)。
 * 单独 export 出来给 server.ts 的 /pending 接口复用类型。
 */
export type ToolApprovalRequest = {
  tool_call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
};

/**
 * iOS 通过 POST /resume 提交的决策。
 * approved=false 时,工具不执行,而是返回一条 "user denied" 的 ToolMessage 给模型。
 * approved=true 且传了 edited_args 时,用编辑过的参数执行(给用户"先改再批"的能力)。
 */
export type ToolApprovalResponse = {
  approved: boolean;
  edited_args?: Record<string, unknown>;
};

function getToolDisplayName(toolName: string): string {
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

// ─── HITL 共享 helper(toolNode 和 evaluateAnswerNode 都用)─────

/**
 * HITL 审批 helper —— 处理一个 tool_call 的"等用户决策"过程。
 *
 * Phase 9 #6 加这个 helper 的背景:
 *   #1-#5 时 HITL 只在 toolNode 里;#6 引入了独立的 evaluateAnswerNode,
 *   也需要 HITL,直接 copy-paste 会有两份 interrupt 逻辑很难维护。
 *   抽出来后,两个节点都调这一个函数,行为一致。
 *
 * # 返回值含义
 *
 *   { kind: "skip" }           → 工具不在审核名单,直接走原路径执行
 *   { kind: "approved", args } → 用户批准了,args 可能是编辑过的
 *   { kind: "rejected", msg }  → 用户拒绝了,带一条 ToolMessage 让模型改口
 *
 * # interrupt() 抛错的传播
 *
 * 这个函数内部调 interrupt(),首跑会抛 GraphInterrupt。错误**不要**
 * 在这里 try/catch,要让它自然向上传播,直到 LangGraph 运行时接住。
 *
 * 调用方(toolNode / evaluateAnswerNode)也不应该 try/catch 这个函数。
 * 同样的,resume 重跑时整个函数会从头执行一次,SSE / 日志的副作用要心里有数。
 */
type ApprovalOutcome =
  | { kind: "skip" }
  | { kind: "approved"; args: Record<string, unknown> }
  | { kind: "rejected"; deniedMessage: ToolMessage };

function processHumanApproval(
  toolCall: ToolCall,
  requestId: string,
  onToolEvent?: (event: ChatStreamEvent) => void
): ApprovalOutcome {
  // 不在审核名单 → 跳过整个 HITL 流程
  if (!TOOLS_REQUIRING_APPROVAL.has(toolCall.name)) {
    return { kind: "skip" };
  }

  const approvalRequest: ToolApprovalRequest = {
    tool_call_id: toolCall.id || "",
    tool_name: toolCall.name,
    args: toolCall.args as Record<string, unknown>,
  };

  // 在 interrupt 之前发 SSE — iOS 端收到这个事件会弹审批卡片。
  // 注意:resume 重跑时这一行**也会再执行一次**,iOS 端按 tool_call_id 去重。
  onToolEvent?.({
    type: "tool_pending",
    tool_call_id: approvalRequest.tool_call_id,
    tool_name: approvalRequest.tool_name,
    display_name: getToolDisplayName(approvalRequest.tool_name),
    args: approvalRequest.args,
  });

  logAgentInfo(requestId, "hitl", "tool_approval_requested", {
    toolName: toolCall.name,
    toolCallId: toolCall.id,
  });

  // ★ interrupt():首跑抛 GraphInterrupt → 图挂起 → 等 /resume
  //   resume 重跑:直接返回 decision,代码继续往下走
  const decision = interrupt<ToolApprovalRequest, ToolApprovalResponse>(
    approvalRequest
  );

  // 走到这里说明已 resume
  logAgentInfo(requestId, "hitl", "tool_approval_resolved", {
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    approved: decision.approved,
    edited: Boolean(decision.edited_args),
  });

  if (!decision.approved) {
    return {
      kind: "rejected",
      deniedMessage: new ToolMessage({
        tool_call_id: toolCall.id || "",
        name: toolCall.name,
        content: JSON.stringify({
          ok: false,
          status: "user_rejected",
          error:
            "The user explicitly REJECTED this tool call. " +
            "DO NOT call this tool again. " +
            "DO NOT attempt to produce the equivalent output yourself (e.g., do NOT write quiz questions, evaluations, or recommendations manually). " +
            "Briefly acknowledge that you won't proceed with this action, and ask the user what they'd like to do instead. " +
            "Keep the response short (1-2 sentences).",
        }),
      }),
    };
  }

  // 用户批准:如果传了编辑过的参数就用编辑版,否则用原参数
  return {
    kind: "approved",
    args: decision.edited_args ?? approvalRequest.args,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/agentGraphNodes.ts — StateGraph 的节点 + 条件边实现
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   agentGraph.ts 调 createAgentNode / createToolNode / shouldContinue
 *   把它们注册到 StateGraph 上,构成 ReAct 循环。
 *
 * 本文件包含:两个核心节点(agent / tool) + 一个条件边判断函数。
 *
 * # 节点(Node)是什么?
 *
 * 在 LangGraph 里,节点就是一个**函数**:
 *
 *   (state, config) => Partial<State>
 *
 * - 接收当前 state
 * - 返回这次想更新的字段(返回 Partial,不需要写完整 state)
 * - 框架会用对应 reducer 把更新合并进总 state
 *
 * 节点可以是 sync / async / generator,LangGraph 都支持。
 *
 *
 * # 条件边(Conditional Edge)是什么?
 *
 * 普通边是"A 节点跑完一定去 B 节点"。
 * 条件边是"A 跑完根据 state 决定去 B、C 还是 D"。
 *
 * 实现方式也是一个函数:
 *
 *   (state, config) => "B" | "C" | "D" | typeof END
 *
 * 返回的是**下一个节点的名字**(或 END 表示结束图)。
 */

/**
 * 创建一个 agentNode 工厂函数。
 *
 * 为什么是"工厂函数"而不是直接 export 一个 agentNode?
 *
 * 因为 agentNode 需要拿到三个"外部依赖":
 *   1. 系统提示词 systemPrompt(每次请求不一样)
 *   2. 工具列表 tools(决定模型能选哪些工具)
 *   3. requestId(写日志用)
 *
 * 这些值在"图编译时"就要确定,但 LangGraph 的 addNode(name, fn) 只接收一个
 * `(state, config) => update` 的纯节点函数,没法多塞参数。
 *
 * 解决办法是经典的**闭包**:外层函数收三个参数,返回一个真正的节点函数,
 * 节点函数通过闭包访问到 systemPrompt / tools / requestId。
 *
 * 这是 LangGraph 项目里最常见的模式,见到 `create...Node(...)` 大概率都是这样。
 */
export function createAgentNode(options: {
  requestId: string;
  systemPrompt: string;
  tools: ClientTool[];
  onModelCallStart?: (runId: string) => void;
  onModelCallEnd?: (runId: string) => void;
}) {
  /**
   * bindTools 把工具的 schema 告诉模型,这样模型才能生成 tool_calls。
   *
   * 这一步等价于 createAgent 内部的 `model.bindTools(tools)`,只是这里
   * 我们手写,所以要自己做。
   *
   * streaming: true 是必须的——streamEvents 要靠模型流式吐 chunk 才能
   * 触发 on_chat_model_stream 事件。
   * disableThinking / disableParallelToolCalls 的原因见 chatModel.ts。
   */
  const modelWithTools = createLangChainChatModel({
    streaming: true,
    disableThinking: true,
    disableParallelToolCalls: true,
  }).bindTools(options.tools);

  /**
   * 真正的节点函数。它的签名 `(state) => Partial<state>` 是 LangGraph 规定的。
   */
  return async function agentNode(state: AgentStateType): Promise<AgentStateUpdate> {
    /**
     * # 第一道防线:模型调用次数上限。
     *
     * createAgent 路径用 modelCallLimitMiddleware 做这件事;
     * 这里我们手写,所以从 state 读 modelCallCount,自己判断。
     *
     * 超额时返回一条"我已尽力,先这样吧"的 AIMessage,让图自然走到 END。
     * 不抛异常的原因:**不希望整个请求失败**,而是优雅降级。
     */
    if (state.modelCallCount >= agentModelCallLimit) {
      logAgentInfo(options.requestId, "agent_node", "model_call_limit_reached", {
        modelCallCount: state.modelCallCount,
        limit: agentModelCallLimit,
      });

      return {
        messages: [
          new AIMessage(
            "我已经达到这一轮的推理上限,先用现有信息回答你。如果还需要继续,请再问一次。"
          ),
        ],
      };
    }

    /**
     * # 真正的模型调用。
     *
     * 把整段历史(state.messages)交给模型,模型会:
     *   - 直接产生回答(content 有内容、tool_calls 为空)
     *   - 或决定调用工具(content 通常为空、tool_calls 有内容)
     *
     * 用流式接口 `.stream(...)`,因为我们要让 token 一个个出来(供 streamEvents 捕获)。
     * 累积出完整 AIMessage 的方式:用 AIMessageChunk 的 `.concat(...)` 合并所有 chunk。
     */
    const runId = `model_call_${Date.now()}`;
    options.onModelCallStart?.(runId);

    let accumulator: AIMessageChunk | undefined;

    /**
     * 把 systemPrompt 作为第一条消息塞到 history 最前面。
     *
     * createAgent 路径是通过 systemPrompt 参数传的;这里手写,
     * 所以每次模型调用前自己拼。
     *
     * 注意每轮都拼 system,但不存到 state.messages 里——
     * 避免 state.messages 越来越长(checkpointer 会把它持久化)。
     *
     * # Phase 11 #4 — 把 state.summary 拼进来
     *
     * 如果 state.summary 非空(说明之前 summarizeNode 跑过,把老对话压缩了),
     * 这里要把摘要作为**第二条 SystemMessage** 塞进来,让模型"看见"早期对话的大意。
     *
     * 拼装顺序:
     *   [system 原 prompt]        ← 角色/规则/工具说明
     *   [system 早期对话摘要]      ← 只在 state.summary 非空时插
     *   [state.messages 全文]     ← 最近 K 个回合的原文(没压缩的部分)
     *
     * 为什么选 SystemMessage 而不是 HumanMessage / AIMessage:
     *   - SystemMessage 在模型眼里是"背景说明",不会被当成"某个角色说过的话"
     *   - 防止模型把摘要误解为"用户上一句"或"我自己上一句",回复跑偏
     *
     * 为什么放在 system 原 prompt 之后、messages 之前:
     *   - 时间线对齐:摘要描述的是"更早的事",自然在 state.messages 原文之前
     *   - 前缀稳定:模型在每次模型调用看到的 system 段都是同样形状,降低混乱
     *
     * 注意这里的拼装**只影响本次模型调用**,不写回 state。
     * state.summary 和 state.messages 仍由 summarizeNode / messagesStateReducer 维护。
     */
    const inputMessages = [
      { role: "system" as const, content: options.systemPrompt },
      ...(state.summary
        ? [
            {
              role: "system" as const,
              content: `以下是更早之前对话的摘要(为节省 token 已压缩,后续 messages 是最近的原文对话):\n\n${state.summary}`,
            },
          ]
        : []),
      ...state.messages,
    ];

    const stream = await modelWithTools.stream(inputMessages);

    for await (const chunk of stream) {
      accumulator =
        accumulator === undefined ? chunk : accumulator.concat(chunk);
    }

    options.onModelCallEnd?.(runId);

    /**
     * 如果模型一个字符都没吐出来(极端异常),用空 AIMessage 兜底。
     * 不抛错的原因还是那条:优雅降级,不让整次请求失败。
     */
    const finalMessage =
      accumulator !== undefined
        ? new AIMessage({
            content: accumulator.content,
            tool_calls: accumulator.tool_calls,
            additional_kwargs: accumulator.additional_kwargs,
            response_metadata: accumulator.response_metadata,
            id: accumulator.id,
          })
        : new AIMessage("");

    /**
     * # 返回部分 state 更新。
     *
     * 把这条 AIMessage 加到 messages(reducer 会 append),
     * 把 modelCallCount += 1(reducer 会累加)。
     *
     * 不需要返回完整 state——这是 LangGraph "增量更新"的核心思想。
     */
    return {
      messages: [finalMessage],
      modelCallCount: 1,
    };
  };
}

/**
 * 创建 toolNode 工厂函数。
 *
 * 职责:看上一条 AIMessage 的 tool_calls,挨个调对应的 LangChain Tool,
 * 把结果包装成 ToolMessage 加入 state。
 *
 * 这是 LangGraph 预设 ToolNode 的"手写版本"。预设 ToolNode 帮你做了:
 *   - 找上一条 AIMessage
 *   - 遍历 tool_calls
 *   - 用 tool_call_id 路由到对应工具
 *   - 包装成 ToolMessage
 *
 * 我们手写是为了**让你看见这个过程**,顺便加上自己的计数器(toolCallCount += 1)。
 */
export function createToolNode(options: {
  requestId: string;
  tools: ClientTool[];
  /**
   * 用来在调 interrupt() 之前推一个 tool_pending SSE 事件给 iOS。
   * 这一步必须在 interrupt 之前同步发出,因为 interrupt 会立刻抛 GraphInterrupt,
   * 之后 toolNode 函数就被中断,没机会再发事件。
   */
  onToolEvent?: (event: ChatStreamEvent) => void;
}) {
  /**
   * 把 tools 数组做成 name → tool 的 Map,后面按 tool_call.name O(1) 查找。
   */
  const toolByName = new Map<string, ClientTool>();
  for (const tool of options.tools) {
    toolByName.set(tool.name, tool);
  }

  return async function toolNode(state: AgentStateType): Promise<AgentStateUpdate> {
    /**
     * # 第一步:找到上一条 AIMessage。
     *
     * 工具调用一定是基于"模型刚刚决定的 tool_calls",所以倒着找最近一条 AI 消息。
     */
    let lastAiMessage: AIMessage | undefined;
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i];
      if (isAIMessage(message)) {
        lastAiMessage = message;
        break;
      }
    }

    /**
     * 理论上 toolNode 只会在"上一条是带 tool_calls 的 AIMessage"时被 shouldContinue
     * 路由进来。如果没找到,说明图配置有问题——返回空更新,让图回 agentNode 兜底。
     */
    if (!lastAiMessage || !lastAiMessage.tool_calls?.length) {
      return {};
    }

    /**
     * # 第二步:挨个调用工具。
     *
     * 注意每个 LangChain Tool 内部已经做了 tool_start / tool_done SSE 发送
     * (见 agentTools.ts:50 行 tool(...) wrapper),所以这里直接 invoke 就行,
     * 不用再做 SSE 事件。
     *
     * 因为我们设了 disableParallelToolCalls: true,一轮里 tool_calls 通常只有 1 个。
     * 但代码写成支持多个的形式,以后哪天打开并发也不用改。
     */
    const toolMessages: ToolMessage[] = [];

    for (const toolCall of lastAiMessage.tool_calls) {
      const tool = toolByName.get(toolCall.name);

      if (!tool) {
        /**
         * 模型生成了一个不存在的工具名(罕见但可能发生,模型偶尔会"幻觉"出工具)。
         * 包装一条 error ToolMessage 给模型,让它换工具或直接回答。
         */
        toolMessages.push(
          new ToolMessage({
            tool_call_id: toolCall.id || "",
            name: toolCall.name,
            content: `Error: tool "${toolCall.name}" not found. Available tools: ${[...toolByName.keys()].join(", ")}`,
          })
        );
        continue;
      }

      /**
       * # HITL 审批 — 抽到 processHumanApproval helper
       *
       * helper 内部 if (TOOLS_REQUIRING_APPROVAL) → interrupt()。
       * 不在审核名单的工具 helper 返回 { kind: "skip" },行为完全不变。
       *
       * ⚠️ 不要把这一行包进 try/catch — helper 里的 interrupt() 抛的
       *    GraphInterrupt 必须冒到 LangGraph 运行时,被 try/catch 接住
       *    就没法挂起了。
       *
       * 关于 "interrupt 重跑两次" 的语义,详见 processHumanApproval 的注释。
       */
      const approval = processHumanApproval(
        toolCall,
        options.requestId,
        options.onToolEvent
      );

      let toolCallArgs = toolCall.args as Record<string, unknown>;

      if (approval.kind === "rejected") {
        toolMessages.push(approval.deniedMessage);
        continue;
      }
      if (approval.kind === "approved") {
        toolCallArgs = approval.args;
      }
      // approval.kind === "skip" 时,沿用原 toolCall.args,直接往下跑

      /**
       * 调用 LangChain Tool。
       *
       * 注意我们把整个 toolCall 对象传给 tool.invoke(...),不只是 args。
       * 因为 LangChain Tool wrapper 内部要从 runtime.toolCallId 取 id
       * 来对齐 tool_start / tool_done 事件——这一切都在 agentTools.ts 的
       * tool(...) wrapper 闭包里。
       *
       * args 用 toolCallArgs(可能被 HITL 编辑过),而不是 toolCall.args。
       */
      const toolResult = await tool.invoke({
        ...toolCall,
        args: toolCallArgs,
        type: "tool_call",
      });

      /**
       * tool.invoke 返回的可能是 string 或 ToolMessage,统一成 ToolMessage。
       */
      if (toolResult instanceof ToolMessage) {
        toolMessages.push(toolResult);
      } else {
        toolMessages.push(
          new ToolMessage({
            tool_call_id: toolCall.id || "",
            name: toolCall.name,
            content:
              typeof toolResult === "string"
                ? toolResult
                : JSON.stringify(toolResult),
          })
        );
      }
    }

    return {
      messages: toolMessages,
      toolCallCount: toolMessages.length,
    };
  };
}

// ─── 子图节点:evaluateAnswerNode ─────────────────────────────

/**
 * 创建 evaluateAnswerNode 工厂函数(Phase 9 #6 新增)。
 *
 * # 这个节点干什么
 *
 * 当模型 tool_call: evaluateAnswer 时,**主图直接路由到这个节点**,
 * 跳过原本的 MCP 路径(LangChain Tool wrapper → MCP client → MCP server →
 * mcpToolHandlers → 子图)。这个节点内部:
 *
 *   1. 找到 AIMessage 里 name=evaluateAnswer 的 tool_call
 *   2. 走 HITL 审批(和 toolNode 共用 processHumanApproval helper)
 *   3. 直接 invoke 子图:runEvaluateAnswerSubgraph(args)
 *   4. 把子图返回的 evaluation 包成 ToolMessage,加入主图 state
 *
 * # 为什么这样设计
 *
 * #5 时子图是"被 MCP 工具调用",绕一大圈才能到 — MCP 那一层增加 RPC 跳数
 * 和序列化开销。对于本来就跑在同进程的子图,完全可以直接 invoke。
 *
 * 这个节点演示了 LangGraph 的一个重要 pattern: **subgraph as graph node**。
 * 主图把子图当成一个普通节点用,子图自己有独立 state schema,通过这个 adapter
 * 节点完成"主图 state ↔ 子图 state"的转换。
 *
 * # 和 toolNode 的关系
 *
 *   shouldContinue 看 AI 消息的 tool_calls:
 *     ├─ 第一个 tool_call 是 evaluateAnswer    → 路由到这个节点
 *     ├─ 其它工具(searchKnowledge / generateQuiz / recommendNextTopic) → 路由到 toolNode
 *     └─ 没有 tool_calls                       → 路由到 END
 *
 *   两个节点都把结果包成 ToolMessage 加进 state.messages,
 *   模型从 messages 看不出"这条 ToolMessage 是从哪个节点来的",
 *   ReAct 循环逻辑保持一致。
 *
 * # state 隔离
 *
 *   子图的 state schema (EvaluateAnswerState) 和主图 (AgentState) 完全独立。
 *   子图运行时**不会**也**没法**写主图的 messages / modelCallCount / toolCallCount。
 *   主图通过这个节点显式把"子图返回值 → ToolMessage"翻译过去,
 *   保证 state 边界清晰。
 */
export function createEvaluateAnswerNode(options: {
  requestId: string;
  onToolEvent?: (event: ChatStreamEvent) => void;
}) {
  return async function evaluateAnswerNode(
    state: AgentStateType
  ): Promise<AgentStateUpdate> {
    // 1. 找到上一条 AIMessage
    let lastAiMessage: AIMessage | undefined;
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i];
      if (isAIMessage(message)) {
        lastAiMessage = message;
        break;
      }
    }

    if (!lastAiMessage || !lastAiMessage.tool_calls?.length) {
      return {};
    }

    // 2. 找到 name=evaluateAnswer 的 tool_call
    //    用 find 而不是 filter 是因为 disableParallelToolCalls=true,一轮里
    //    最多一个 evaluateAnswer 调用。即使万一并发,也只处理第一个。
    const evaluateCall = lastAiMessage.tool_calls.find(
      (tc) => tc.name === "evaluateAnswer"
    );

    if (!evaluateCall) {
      // shouldContinue 配错了才会进到这里 — 防御性返回空更新
      return {};
    }

    const toolMessages: ToolMessage[] = [];

    // 3. HITL 审批(和 toolNode 共用 helper)
    const approval = processHumanApproval(
      evaluateCall,
      options.requestId,
      options.onToolEvent
    );

    if (approval.kind === "rejected") {
      // 用户拒绝 → 同样塞 "user_rejected" ToolMessage 给模型,行为和 toolNode 一致
      toolMessages.push(approval.deniedMessage);
      return {
        messages: toolMessages,
        toolCallCount: 1,
      };
    }

    // approval.kind 是 "approved" 或 "skip" (evaluateAnswer 在审核名单里所以
    // 实际上不会出现 skip,但写完整保险)
    const finalArgs =
      approval.kind === "approved"
        ? approval.args
        : (evaluateCall.args as Record<string, unknown>);

    // 4. 发 tool_start SSE(toolNode 路径里这一步由 LangChain Tool wrapper 做,
    //    我们这里直连子图,wrapper 不参与,所以要自己发)
    options.onToolEvent?.({
      type: "tool_start",
      tool_call_id: evaluateCall.id || "",
      tool_name: evaluateCall.name,
      display_name: getToolDisplayName(evaluateCall.name),
      message: `正在${getToolDisplayName(evaluateCall.name)}`,
    });

    logAgentInfo(options.requestId, "tool_execution", "started", {
      runId: evaluateCall.id,
      toolName: evaluateCall.name,
      source: "evaluateAnswerNode",
    });

    const startedAt = Date.now();
    let resultMessage: ToolMessage;
    let resultOk = true;
    let resultSummary = "已批改答题";

    try {
      // 5. ★ 直接 invoke 子图 ★
      //    这是这个节点的核心 — 不走 MCP,直接调子图的对外入口函数。
      //    runEvaluateAnswerSubgraph 内部会编译图(已缓存)+ invoke,
      //    返回 EvaluateAnswerOutput。
      const evaluation = await runEvaluateAnswerSubgraph({
        question: typeof finalArgs.question === "string" ? finalArgs.question : "",
        userAnswer:
          typeof finalArgs.userAnswer === "string" ? finalArgs.userAnswer : "",
        topic: typeof finalArgs.topic === "string" ? finalArgs.topic : undefined,
        expectedConcepts: Array.isArray(finalArgs.expectedConcepts)
          ? (finalArgs.expectedConcepts as string[])
          : undefined,
      });

      // 6. 包成 ToolMessage,格式和 toolNode 走 MCP 时一致
      //    (上层模型看到的 ToolMessage 长得跟 MCP 路径一模一样)
      resultMessage = new ToolMessage({
        tool_call_id: evaluateCall.id || "",
        name: evaluateCall.name,
        content: JSON.stringify({
          toolName: "evaluateAnswer",
          ok: true,
          result: {
            question: finalArgs.question,
            topic: finalArgs.topic,
            ...evaluation,
          },
        }),
      });

      if (typeof evaluation.score === "number") {
        resultSummary = `已批改:${evaluation.scoreLabel} (${evaluation.score}/3)`;
      }
    } catch (error) {
      // 子图执行失败(LLM 超时 / 网络挂)→ 包成 ok=false 给模型
      resultOk = false;
      resultSummary = "批改失败,模型暂时不可用";
      resultMessage = new ToolMessage({
        tool_call_id: evaluateCall.id || "",
        name: evaluateCall.name,
        content: JSON.stringify({
          toolName: "evaluateAnswer",
          ok: false,
          error: `Evaluation subgraph failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      });
    }

    // 7. 发 tool_done SSE + 写日志
    const durationMs = Date.now() - startedAt;
    options.onToolEvent?.({
      type: "tool_done",
      tool_call_id: evaluateCall.id || "",
      tool_name: evaluateCall.name,
      display_name: getToolDisplayName(evaluateCall.name),
      ok: resultOk,
      message: resultSummary,
    });

    logAgentInfo(options.requestId, "tool_execution", "completed", {
      runId: evaluateCall.id,
      toolName: evaluateCall.name,
      source: "evaluateAnswerNode",
      durationMs,
      ok: resultOk,
    });

    toolMessages.push(resultMessage);

    return {
      messages: toolMessages,
      toolCallCount: 1,
    };
  };
}

// ─── 条件边 shouldContinue ────────────────────────────────────

/**
 * 条件边函数 shouldContinue。
 *
 * # 它放在哪儿?
 *
 * 在 agentGraph.ts 里图的连法是:
 *
 *   START → agentNode → (条件)
 *                         ├─── "evaluateAnswer" → 子图直连 → agentNode (回头)
 *                         ├─── "tools"          → toolNode  → agentNode (回头)
 *                         └─── END
 *
 * 这个函数看 agentNode 刚产生的 AIMessage:
 *   - 有 tool_call.name === "evaluateAnswer" → 路由到 evaluateAnswerNode(直接走子图)
 *   - 有其它 tool_calls                      → 路由到 toolNode(走 MCP)
 *   - 没 tool_calls                          → END
 *
 * # 等价物
 *
 * LangGraph 预设里有 `toolsCondition`(在 prebuilt/tool_node.ts),
 * 实现是"有 tool_calls → tools / 无 → END"的简单版。
 * 我们手写并扩展成"按 tool name 分流",展示条件边的实际灵活性。
 *
 * # 为什么 evaluateAnswer 单挑出来
 *
 * 它是项目里唯一被重构成"子图"的工具。其它 3 个工具(searchKnowledge /
 * generateQuiz / recommendNextTopic)还是走 MCP 路径,因为:
 *   - searchKnowledge 是纯本地 RAG,简单一步搞定,没必要拆子图
 *   - generateQuiz / recommendNextTopic 内部也是单 LLM 调用,
 *     拆子图的收益(可测试性)边际很低
 *
 * 把 evaluateAnswer 拆成子图最值得是因为它的 3 步(prepareContext / grade /
 * validate)各自独立,有清晰的"prompt 构造 → LLM 调用 → 结果解析"边界。
 */
export function shouldContinue(
  state: AgentStateType
): "tools" | "evaluateAnswer" | typeof END {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];

  // 三种情况返回 END:
  //   1. 没有任何消息(理论上不会,起码有用户消息)
  //   2. 最后一条不是 AIMessage(agent 还没决策,逻辑错乱)
  //   3. AIMessage 没有 tool_calls(模型决定直接回答)
  if (!lastMessage || !isAIMessage(lastMessage)) {
    return END;
  }

  const toolCalls: ToolCall[] | undefined = lastMessage.tool_calls;

  if (!toolCalls || toolCalls.length === 0) {
    return END;
  }

  // evaluateAnswer 单独路由到子图节点
  // (disableParallelToolCalls=true 保证一轮只有一个 tool_call,所以 some 等价于 only)
  if (toolCalls.some((tc) => tc.name === "evaluateAnswer")) {
    return "evaluateAnswer";
  }

  // 其它工具走 toolNode(MCP 路径)
  return "tools";
}

/**
 * 一个调试用的小工具:把 BaseMessage 数组里最后一条 AIMessage 的文本拿出来。
 *
 * 主要给 agentGraph.ts 在图跑完后取最终回答用。
 * 用 messageContentToString 是因为 content 可能是 string 也可能是 complex[]。
 */
export function extractFinalAssistantText(
  messages: AgentStateType["messages"]
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isAIMessage(message)) {
      const text = messageContentToString(message.content);
      if (text.trim()) {
        return text;
      }
    }
  }

  return "";
}

/**
 * 提示:手写 StateGraph 路径目前没用到 agentModelRetryMaxAttempts。
 *
 * createAgent 路径有 modelRetryMiddleware 做"一轮失败重跑整个 model node"。
 * 手写图想做这件事需要在 agentNode 里加 try/catch + 重试循环——
 * 为了让代码尽量贴近"最小可运行 ReAct 图",这里暂时不做软件层重试。
 * HTTP 层的 chatModelHttpMaxRetries 仍然生效(ChatDeepSeek 自带)。
 *
 * 想加的话:参考 modelRetryMiddleware 源码,在 agentNode 外包一层带指数退避的 try/catch。
 */
void agentModelRetryMaxAttempts;
