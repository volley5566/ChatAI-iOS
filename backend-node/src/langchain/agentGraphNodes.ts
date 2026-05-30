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
     */
    const inputMessages = [
      { role: "system" as const, content: options.systemPrompt },
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
       * # HITL: 如果是审核名单里的工具,先 interrupt() 等用户批准。
       *
       * ## interrupt() 的语义(LangGraph 1.x 的怪异之处)
       *
       *   第一次跑到 interrupt(payload):
       *      抛 GraphInterrupt(payload) → 图挂起 → state 进 checkpointer
       *      streamEvents 自然结束,server 知道"我在等审批"
       *
       *   外部用 Command(resume=decision) 续跑:
       *      LangGraph **从节点头部重新执行**这个函数
      *      interrupt() 这次不抛错,**同步返回 decision**
       *
       * ## "重跑两次"的视觉化
       *
       *      首跑:                       resume 重跑:
       *      ─────────────                ─────────────
       *      enter toolNode               enter toolNode
       *      ...loop pre-work             ...loop pre-work    ← 重复执行!
       *      onToolEvent(tool_pending)    onToolEvent(tool_pending) ← SSE 又发一次
       *      logAgentInfo("requested")    logAgentInfo("requested") ← 日志又记一次
       *      interrupt() → ★抛错挂起      interrupt() → ★直接返回 decision
       *      (永远不会跑到这里)            ↓
       *                                    if (!decision.approved) ...
       *                                    tool.invoke(...) → 工具真执行
       *
       * ## 重跑带来的麻烦
       *
       *   ⚠️  tool_pending SSE 在 resume 时**会被发第二次**,iOS 端按
       *       tool_call_id 去重,见 ChatViewModel.justResumedToolCallID。
       *
       *   ⚠️  logAgentInfo("tool_approval_requested") 在 resume 时也会再写一条,
       *       看后端日志会"莫名其妙多一行",不是 bug,是 LangGraph 设计如此。
       *
       *   ⚠️  pre-work 不能有副作用(写数据库、发邮件等),否则会执行两次。
       *       这里 pre-work 只发 SSE 和写日志,SSE 已经做了 iOS 端去重,日志多一条无所谓。
       *
       * ## 为什么 LangGraph 这么设计
       *
       *   它没办法存"代码跑到第几行" — 那需要保存 JavaScript 调用栈快照。
       *   它只能存 state(数据)。所以 resume 时必须从函数头部重跑,
       *   靠 interrupt() 直接返回 resume 值来"快进"到挂起前的位置。
       *
       * 不在审核名单的工具直接跳过整个 if,走原路径,行为完全不变。
       */
      let toolCallArgs = toolCall.args as Record<string, unknown>;

      if (TOOLS_REQUIRING_APPROVAL.has(toolCall.name)) {
        const approvalRequest: ToolApprovalRequest = {
          tool_call_id: toolCall.id || "",
          tool_name: toolCall.name,
          args: toolCallArgs,
        };

        // 在 interrupt 之前发 SSE 通知 iOS。
        // 不要把这行包进 try/catch — interrupt 抛的 GraphInterrupt 必须冒出去。
        options.onToolEvent?.({
          type: "tool_pending",
          tool_call_id: approvalRequest.tool_call_id,
          tool_name: approvalRequest.tool_name,
          display_name: getToolDisplayName(approvalRequest.tool_name),
          args: approvalRequest.args,
        });

        logAgentInfo(options.requestId, "hitl", "tool_approval_requested", {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
        });

        // 关键:interrupt() 抛错 → 图挂起 → 等 /resume 接口续跑
        const decision = interrupt<ToolApprovalRequest, ToolApprovalResponse>(
          approvalRequest
        );

        // 走到这里说明已经 resume,decision 是 iOS 提交的批准/拒绝决定
        logAgentInfo(options.requestId, "hitl", "tool_approval_resolved", {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          approved: decision.approved,
          edited: Boolean(decision.edited_args),
        });

        if (!decision.approved) {
          // 用户拒绝:不调用工具,塞一条**强约束**的 ToolMessage 给模型。
          //
          // 早期版本只说"Please answer without using this tool"——
          // 这给模型留了"那我自己手写一份吧"的空间。
          // 比如用户拒绝 generateQuiz 后,模型会自己拼一份题目回答用户,
          // 用户看到结果会困惑"我不是说不要了吗"。
          //
          // 现在的措辞要做到三点:
          //   1. 明确说"用户拒绝了" + "你也不要自己做这件事"
          //   2. 告诉模型"用户改主意了,问他想干嘛"
          //   3. 用 status: "user_rejected" 这种结构化字段,
          //      配合 prompts.ts 里的 agentOutputGuide 让模型稳定识别这种情况
          toolMessages.push(
            new ToolMessage({
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
            })
          );
          continue;
        }

        // 用户批准:如果传了编辑过的参数,用编辑版;否则用原参数
        if (decision.edited_args) {
          toolCallArgs = decision.edited_args;
        }
      }

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

/**
 * 条件边函数 shouldContinue。
 *
 * # 它放在哪儿?
 *
 * 在 agentGraph.ts 里图的连法是:
 *
 *   START → agentNode → (条件)
 *                         ├─── "tools" → toolNode → agentNode (回头)
 *                         └─── END
 *
 * 条件边的判断逻辑就是这个函数:**看 agentNode 刚产生的 AIMessage 有没有 tool_calls**。
 * 有就去 toolNode 执行工具,没有就结束图。
 *
 *
 * # 等价物
 *
 * LangGraph 预设里有 `toolsCondition`(在 prebuilt/tool_node.ts),
 * 实现几乎一模一样。我们手写是为了你能亲眼看到这个判断有多简单——
 * 这就是 ReAct 循环里"该停了吗?"的整个判断逻辑。
 */
export function shouldContinue(state: AgentStateType): "tools" | typeof END {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];

  /**
   * 三种情况返回 END:
   * 1. 没有任何消息(理论上不会,起码有用户消息)
   * 2. 最后一条不是 AIMessage(说明 agent 还没决策,逻辑错乱)
   * 3. AIMessage 没有 tool_calls(模型决定直接回答,不调工具)
   */
  if (!lastMessage || !isAIMessage(lastMessage)) {
    return END;
  }

  const toolCalls: ToolCall[] | undefined = lastMessage.tool_calls;

  if (!toolCalls || toolCalls.length === 0) {
    return END;
  }

  /**
   * 有 tool_calls,说明模型要调工具,路由到 "tools" 节点。
   * "tools" 是我们在 agentGraph.ts 里给 toolNode 起的名字。
   */
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
