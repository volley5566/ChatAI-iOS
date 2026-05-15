import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  buildToolDoneEvent,
  buildToolStartEvent,
  executeAgentTool,
  getAgentTools,
  stringifyToolResult,
} from "./agentTools";
import {
  getDurationMs,
  getToolCallLogData,
  logAgentError,
  logAgentInfo,
} from "./agentObservability";
import { buildAgentInstructions } from "../chat/prompts";
import type {
  ChatStreamEvent,
  DeepSeekAssistantMessageWithReasoning,
  NormalizedChatHistoryItem,
} from "../shared/types";

const maxAgentToolSteps = 4;

export type AgentRunResult = {
  messages: ChatCompletionMessageParam[];
  toolCallCount: number;
};

function buildAgentMessages(
  message: string,
  systemPrompt: string | undefined,
  history: NormalizedChatHistoryItem[]
): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: buildAgentInstructions(systemPrompt),
    },
    ...history.map((item): ChatCompletionMessageParam => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user",
      content: message,
    },
  ];
}

/**
 * 把模型返回的 assistant tool_call 消息整理成下一轮请求可用的 message。
 *
 * DeepSeek thinking mode 要求 reasoning_content 原样传回。
 * OpenAI SDK 类型里没有这个字段，所以用本地扩展类型保留。
 */
function buildAssistantToolMessage(
  assistantMessage: DeepSeekAssistantMessageWithReasoning,
  toolCalls: ChatCompletionMessageToolCall[]
): ChatCompletionAssistantMessageParam {
  const assistantToolMessage: DeepSeekAssistantMessageWithReasoning = {
    role: "assistant",
    content: assistantMessage.content ?? null,
    tool_calls: toolCalls,
  };

  if (typeof assistantMessage.reasoning_content === "string") {
    assistantToolMessage.reasoning_content = assistantMessage.reasoning_content;
  }

  return assistantToolMessage;
}

function getToolDefinitionName(tool: ChatCompletionTool): string {
  if (tool.type === "function") {
    return tool.function.name;
  }

  return tool.type;
}

type RunAgentToolLoopOptions = {
  deepseek: OpenAI;
  requestId: string;
  model: string;
  message: string;
  systemPrompt: string | undefined;
  history: NormalizedChatHistoryItem[];
  onToolEvent?: (event: ChatStreamEvent) => void;
};

/**
 * 执行 Agent 的“工具调用阶段”。
 *
 * 阶段 1：非流式 tool calling，模型决定是否调用工具，后端执行工具。
 * 阶段 2：由 server.ts 继续用 stream: true 输出最终回答。
 */
export async function runAgentToolLoop({
  deepseek,
  requestId,
  model,
  message,
  systemPrompt,
  history,
  onToolEvent,
}: RunAgentToolLoopOptions): Promise<AgentRunResult> {
  const loopStartedAt = Date.now();

  // Agent 先构造 messages。
  // 因为 DeepSeek 不是只看当前一句话，它需要知道系统规则、历史上下文、当前问题。
  /**
   * [
   *   { role: "system", content: "你是 iOS 学习助手，可以使用工具..." },
   *   { role: "user", content: "上一轮问题" },
   *   { role: "assistant", content: "上一轮回答" },
   *   { role: "user", content: "当前问题" }
   * ]
   */
  // buildAgentMessages 它先构造消息。
  const messages = buildAgentMessages(message, systemPrompt, history);

  logAgentInfo(requestId, "tool_loop", "messages_prepared", {
    model,
    historyCount: history.length,
    messageCount: messages.length,
    maxAgentToolSteps,
  });

  /**
   * 这里拿到的是“给模型看的工具定义”。
   *
   * 注意这个工具列表已经经过了一次转换：
   * MCP tools -> OpenAI-compatible tools。
   *
   * 模型不会知道背后是 MCP，它只知道自己可以返回 tool_calls。
   * 后端收到 tool_calls 后，才通过 MCP client 调用真正的 MCP server。
   */
  /**
   * Agent 从 MCP 获取工具列表
   *
   * agentRunner
   * -> agentTools.getAgentTools()
   * -> mcpClient.getMcpAgentTools()
   * -> MCP server listTools()
   *
   * 为什么要从 MCP 获取？
   * 因为工具定义不写死在 DeepSeek 请求里，而是由 MCP server 统一暴露。以后你增加新工具时，核心 Agent 流程不用大改。
   */
  // 然后拿工具列表。
  // 这里拿到的工具不是手写死的，而是来自 MCP server。
  const loadToolsStartedAt = Date.now();
  let agentTools;

  try {
    agentTools = await getAgentTools();
  } catch (error) {
    logAgentError(requestId, "tool_setup", "tools_load_failed", error, {
      durationMs: getDurationMs(loadToolsStartedAt),
    });
    throw error;
  }

  logAgentInfo(requestId, "tool_setup", "tools_loaded", {
    durationMs: getDurationMs(loadToolsStartedAt),
    toolCount: agentTools.length,
    toolNames: agentTools.map(getToolDefinitionName),
  });

  let toolCallCount = 0;

  for (let step = 0; step < maxAgentToolSteps; step += 1) {
    /**
     * 然后让 DeepSeek 决定是否调用工具
     *
     * 工具决策阶段使用非流式请求。
     *
     * 原因：
     * - 第一版学习项目里，非流式 tool calling 更容易理解和调试
     * - DeepSeek 返回完整 assistant message 后，才能稳定拿到 tool_calls
     * - 工具阶段结束后，最终回答仍然会走 stream: true，保证 iOS 体验
     *
     * 这一阶段不是流式，因为要先完整拿到 tool_calls
     */
    /**
     * DeepSeek 判断要不要调用工具
     *
     * 这里非常核心。
     * 这一步 DeepSeek 做的不是最终回答，而是“决策”：
     * 我是否需要调用工具？
     * 如果需要，调用哪个工具？
     * 参数是什么？
     *
     * 注意：DeepSeek 不直接查知识库。它只是提出“我要调用这个工具”
     */
    /**
     * {
     *   "tool_calls": [
     *     {
     *       "function": {
     *         "name": "searchKnowledge",
     *         "arguments": "{\"query\":\"SwiftUI @State\"}"
     *       }
     *     }
     *   ]
     * }
     */
    const decisionStartedAt = Date.now();

    logAgentInfo(requestId, "tool_decision", "started", {
      step,
      model,
      messageCount: messages.length,
      toolCount: agentTools.length,
    });

    let completion: ChatCompletion;

    try {
      completion = await deepseek.chat.completions.create({
        model,
        messages,
        // tools：告诉模型有哪些工具可以用。
        tools: agentTools,
        // tool_choice: "auto"：让模型自己判断要不要调用工具。
        tool_choice: "auto",
      });
    } catch (error) {
      logAgentError(requestId, "tool_decision", "failed", error, {
        step,
        durationMs: getDurationMs(decisionStartedAt),
      });
      throw error;
    }

    const assistantMessage = completion.choices[0]
      ?.message as DeepSeekAssistantMessageWithReasoning | undefined;

    if (!assistantMessage) {
      logAgentInfo(requestId, "tool_decision", "no_assistant_message", {
        step,
        durationMs: getDurationMs(decisionStartedAt),
      });
      break;
    }

    // 如果模型返回工具调用。
    const toolCalls = assistantMessage.tool_calls || [];

    logAgentInfo(requestId, "tool_decision", "completed", {
      step,
      durationMs: getDurationMs(decisionStartedAt),
      modelCalledTools: toolCalls.length > 0,
      toolCallCount: toolCalls.length,
      toolCalls: toolCalls.map(getToolCallLogData),
    });

    if (toolCalls.length === 0) {
      /**
       * 没有 tool_calls 表示模型认为工具阶段结束。
       * 后续由 server.ts 使用 agentRun.messages 开启最终流式回答。
       */
      break;
    }

    toolCallCount += toolCalls.length;

    /**
     * OpenAI-compatible tool calling 要求：
     * assistant 的 tool_calls 消息必须放回 messages，
     * 然后每个 tool_call 再配一条 role=tool 的结果消息。
     *
     * 这样下一轮模型才能知道：
     * “我刚才请求了哪个工具，工具返回了什么结果。”
     */
    messages.push(buildAssistantToolMessage(assistantMessage, toolCalls));

    // 后端就循环执行，后端真正执行工具。
    /**
     * 模型不是直接执行工具
     * 模型只是说：“我想调用 searchKnowledge，参数是 xxx。”
     * 真正执行工具的是后端。
     * 执行完后，后端把结果作为 role: "tool" 放回 messages，让模型继续理解。
     */
    /**
     * 1. 先告诉 iOS：工具开始了。
     * 2. 后端执行工具。
     * 3. 再告诉 iOS：工具完成了。
     * 4. 把工具结果放回 messages，准备交给 DeepSeek。
     *
     * 为什么工具结果要放回 messages？
     * 因为 DeepSeek 需要看到工具返回了什么，才能基于工具结果生成最终答案。
     */
    for (const toolCall of toolCalls) {
      const toolStartedAt = Date.now();
      const toolLogData = getToolCallLogData(toolCall);

      logAgentInfo(requestId, "tool_execution", "started", {
        step,
        ...toolLogData,
      });

      onToolEvent?.(buildToolStartEvent(toolCall));

      /**
       * 真实执行从这里进入 MCP：
       * executeAgentTool -> mcpClient.callTool -> mcpServer handler。
       */
      let toolResult: Awaited<ReturnType<typeof executeAgentTool>>;

      try {
        toolResult = await executeAgentTool(toolCall);
      } catch (error) {
        logAgentError(requestId, "tool_execution", "failed", error, {
          step,
          durationMs: getDurationMs(toolStartedAt),
          ...toolLogData,
        });
        throw error;
      }

      logAgentInfo(requestId, "tool_execution", "completed", {
        step,
        durationMs: getDurationMs(toolStartedAt),
        ...toolLogData,
        ok: toolResult.ok,
        result: toolResult,
      });

      onToolEvent?.(buildToolDoneEvent(toolCall, toolResult));

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: stringifyToolResult(toolResult),
      });
    }
  }

  logAgentInfo(requestId, "tool_loop", "completed", {
    durationMs: getDurationMs(loopStartedAt),
    modelCalledTools: toolCallCount > 0,
    toolCallCount,
    finalMessageCount: messages.length,
  });

  return {
    messages,
    toolCallCount,
  };
}
