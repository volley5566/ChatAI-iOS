import type OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import {
  buildToolDoneEvent,
  buildToolStartEvent,
  executeAgentTool,
  getAgentTools,
  stringifyToolResult,
} from "./agentTools";
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

type RunAgentToolLoopOptions = {
  deepseek: OpenAI;
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
  model,
  message,
  systemPrompt,
  history,
  onToolEvent,
}: RunAgentToolLoopOptions): Promise<AgentRunResult> {
  const messages = buildAgentMessages(message, systemPrompt, history);

  /**
   * 这里拿到的是“给模型看的工具定义”。
   *
   * 注意这个工具列表已经经过了一次转换：
   * MCP tools -> OpenAI-compatible tools。
   *
   * 模型不会知道背后是 MCP，它只知道自己可以返回 tool_calls。
   * 后端收到 tool_calls 后，才通过 MCP client 调用真正的 MCP server。
   */
  const agentTools = await getAgentTools();
  let toolCallCount = 0;

  for (let step = 0; step < maxAgentToolSteps; step += 1) {
    /**
     * 工具决策阶段使用非流式请求。
     *
     * 原因：
     * - 第一版学习项目里，非流式 tool calling 更容易理解和调试
     * - DeepSeek 返回完整 assistant message 后，才能稳定拿到 tool_calls
     * - 工具阶段结束后，最终回答仍然会走 stream: true，保证 iOS 体验
     */
    const completion = await deepseek.chat.completions.create({
      model,
      messages,
      tools: agentTools,
      tool_choice: "auto",
    });

    const assistantMessage = completion.choices[0]
      ?.message as DeepSeekAssistantMessageWithReasoning | undefined;

    if (!assistantMessage) {
      break;
    }

    const toolCalls = assistantMessage.tool_calls || [];

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

    for (const toolCall of toolCalls) {
      onToolEvent?.(buildToolStartEvent(toolCall));

      /**
       * 真实执行从这里进入 MCP：
       * executeAgentTool -> mcpClient.callTool -> mcpServer handler。
       */
      const toolResult = await executeAgentTool(toolCall);

      console.log(
        `[Agent] tool call: ${toolCall.type === "function" ? toolCall.function.name : toolCall.type}, ok: ${toolResult.ok}`
      );

      onToolEvent?.(buildToolDoneEvent(toolCall, toolResult));

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: stringifyToolResult(toolResult),
      });
    }
  }

  return {
    messages,
    toolCallCount,
  };
}
