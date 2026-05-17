import {
  AIMessage,
  AIMessageChunk,
  isAIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ClientTool } from "@langchain/core/tools";
import type { ToolCall } from "@langchain/core/messages/tool";
import { END } from "@langchain/langgraph";
import {
  agentModelCallLimit,
  agentModelRetryMaxAttempts,
} from "../config/env";
import { logAgentInfo } from "../agent/agentObservability";
import type { AgentStateType, AgentStateUpdate } from "./agentGraphState";
import { createLangChainChatModel } from "./chatModel";
import { messageContentToString } from "./chatPrompt";

/**
 * Phase 4 — 节点实现。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个文件包含图里的"两个核心节点"和"一个条件边判断函数"。
 * ─────────────────────────────────────────────────────────────────────
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
   * 这一步等价于 Phase 3 createAgent 内部的 `model.bindTools(tools)`。
   * 现在我们手写,所以要自己做。
   *
   * 注意 chatModel 是 streaming 模式——这是 Phase 3 的设计延续:
   * token 流式输出需要底层 SDK 走 SSE 模式。
   *
   * disableThinking / disableParallelToolCalls 也维持 Phase 3 的判断,
   * 详见 chatModel.ts 里的注释。
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
     * Phase 3 用 modelCallLimitMiddleware 做这件事;
     * Phase 4 我们手写,所以在 state 里读 modelCallCount,自己判断。
     *
     * 超额怎么办?返回一条"我已尽力,先这样吧"的 AIMessage,让图自然走到 END。
     * 不抛异常的原因是:**不希望整个请求失败**,而是优雅降级。
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
     * Phase 3 是通过 createAgent 的 systemPrompt 参数传的;
     * Phase 4 手写,所以要在每次模型调用前自己拼。
     *
     * 注意每轮都拼 system,不存到 state.messages 里,
     * 避免 state.messages 越来越长(checkpointer 会持久化)。
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
     * Phase 3 用 disableParallelToolCalls: true,所以一轮里 tool_calls 通常只有 1 个。
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
       * 调用 LangChain Tool。
       *
       * 注意我们把整个 toolCall 对象传给 tool.invoke(...),不只是 args。
       * 因为 LangChain Tool wrapper 内部要从 runtime.toolCallId 取 id
       * 来对齐 tool_start / tool_done 事件——这一切都在
       * agentTools.ts:52 行那段闭包里。
       */
      const toolResult = await tool.invoke({
        ...toolCall,
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
 * 提示:agentModelRetryMaxAttempts 这个配置 Phase 4 没用到。
 *
 * Phase 3 modelRetryMiddleware 在 createAgent 内部做"一轮失败重跑整个 model node"。
 * Phase 4 我们手写图,要做这件事需要在 agentNode 里加 try/catch + 重试循环。
 *
 * 为了让 Phase 4 代码尽量贴近"最小可运行 ReAct 图",这里暂时不做软件层重试。
 * HTTP 层的 chatModelHttpMaxRetries 仍然生效(ChatDeepSeek 自带)。
 *
 * 后续如果想加,可以参考 modelRetryMiddleware 源码,在 agentNode 外面包一层
 * 带指数退避的 try/catch。
 */
void agentModelRetryMaxAttempts;
