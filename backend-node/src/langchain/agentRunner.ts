import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import {
  createAgent,
  toolCallLimitMiddleware,
} from "langchain";
import type { ClientTool } from "@langchain/core/tools";
import { buildAgentInstructions } from "../chat/prompts";
import {
  getDurationMs,
  logAgentError,
  logAgentInfo,
} from "../agent/agentObservability";
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
  onToolEvent?: (event: ChatStreamEvent) => void;
  onDelta?: (delta: string) => void;
  shouldStop?: () => boolean;
};

const langChainAgentRecursionLimit = 8;

/**
 * LangChain Agent Runner。
 *
 * 第二阶段后，Agent 的核心循环不再由我们手写：
 *
 *   while step < maxSteps
 *     model decides tool_calls
 *     backend executes tools
 *     append tool messages
 *
 * 这部分交给 LangChain createAgent。
 *
 * 我们保留的职责是：
 * - 构造系统提示词和历史消息
 * - 从 MCP 动态创建 LangChain tools
 * - 把工具执行过程转成 iOS SSE 事件
 * - 把 LangChain 的最终文本 token 转成 delta
 * - 写项目自己的 requestId 日志
 */
export async function runLangChainAgentStream({
  requestId,
  message,
  systemPrompt,
  history,
  onToolEvent,
  onDelta,
  shouldStop,
}: RunLangChainAgentStreamOptions): Promise<LangChainAgentRunResult> {
  const startedAt = Date.now();
  let toolCallCount = 0;
  let outputText = "";

  const tools = await loadLangChainTools(requestId, {
    onToolEvent,
    onToolCompleted: () => {
      toolCallCount += 1;
    },
  });

  const agent = createAgent({
    /**
     * DeepSeek 对 tool message 的顺序校验比较严格：
     * 每条 role=tool 的消息前面必须紧跟带 tool_calls 的 assistant 消息。
     *
     * Agent 这里还额外关闭 thinking mode：
     * DeepSeek thinking mode 会返回 reasoning_content，并要求工具下一轮原样带回；
     * 当前 LangChain OpenAI converter 不会把这个字段带回请求体，所以工具链路
     * 使用 non-thinking mode 更稳定。
     *
     * server.ts 仍然通过 SSE 输出 delta。当前实现会在 Agent 完成后发送一次
     * 完整文本 delta；后续如果 LangChain/DeepSeek streaming tool-call 兼容稳定，
     * 再把这里升级回 token 级流式。
     */
    model: createLangChainChatModel({
      streaming: false,
      disableThinking: true,
      disableParallelToolCalls: true,
    }),
    tools,
    systemPrompt: buildAgentInstructions(systemPrompt),
    middleware: buildAgentMiddleware(),
    version: "v2",
  });

  const messages = buildAgentMessages(message, history);

  logAgentInfo(requestId, "langchain_agent", "started", {
    messageCount: messages.length,
    toolCount: tools.length,
    recursionLimit: langChainAgentRecursionLimit,
  });

  const finalState = await agent.invoke(
    {
      messages,
    },
    {
      recursionLimit: langChainAgentRecursionLimit,
    }
  );

  /**
   * LangChain Agent 完成后，最终 state.messages 里会包含完整对话：
   * HumanMessage -> AIMessage(tool_calls) -> ToolMessage -> AIMessage(final answer)
   *
   * 注意：不要直接把中间 ToolMessage 的内容发给 iOS。
   * ToolMessage 通常是完整 JSON，只应该给模型看；iOS 只显示 tool_start/tool_done 摘要。
   */
  outputText = extractFinalAssistantText(finalState.messages) || "";

  if (outputText && !shouldStop?.()) {
    onDelta?.(outputText);
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
   * 这一步把“不要重复乱调工具”的规则从 prompt 升级成代码约束。
   *
   * Prompt 负责告诉模型“应该怎么做”；
   * middleware 负责硬性限制“最多能做几次”。
   */
  return [
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

function extractFinalAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message instanceof AIMessage) {
      const text = messageContentToString(message.content);

      if (text.trim()) {
        return text;
      }
    }
  }

  return undefined;
}
