import type OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import {
  agentTools,
  buildToolDoneEvent,
  buildToolStartEvent,
  executeAgentTool,
  stringifyToolResult,
} from "./agentTools";
import { buildAgentInstructions } from "./prompts";
import type {
  ChatStreamEvent,
  DeepSeekAssistantMessageWithReasoning,
  NormalizedChatHistoryItem,
} from "./types";

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
  let toolCallCount = 0;

  for (let step = 0; step < maxAgentToolSteps; step += 1) {
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
      break;
    }

    toolCallCount += toolCalls.length;
    messages.push(buildAssistantToolMessage(assistantMessage, toolCalls));

    for (const toolCall of toolCalls) {
      onToolEvent?.(buildToolStartEvent(toolCall));

      const toolResult = executeAgentTool(toolCall);

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
