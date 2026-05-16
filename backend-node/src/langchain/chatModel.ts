import { ChatDeepSeek } from "@langchain/deepseek";
import type { BaseMessage } from "@langchain/core/messages";
import { deepseekBaseURL, model, requireDeepSeekApiKey } from "../config/env";
import { messageContentToString } from "./chatPrompt";

type CreateLangChainChatModelOptions = {
  streaming?: boolean;
};

/**
 * LangChain DeepSeek chat model 工厂。
 *
 * 现在普通 RAG 聊天会走：
 *
 *   ChatPromptTemplate -> BaseMessage[] -> ChatDeepSeek
 *
 * Agent 工具循环暂时仍保留原来的 OpenAI SDK 低层调用，
 * 因为那边有 MCP tool_call、SSE 进度事件、reasoning_content 兼容逻辑。
 *
 * 这种拆法的目标是：
 * - 普通 RAG 链路尽量 LangChain 化
 * - Agent/MCP 学习主线不被黑盒 Agent 抽象吞掉
 */
export function createLangChainChatModel(
  options: CreateLangChainChatModelOptions = {}
): ChatDeepSeek {
  return new ChatDeepSeek({
    model,
    apiKey: requireDeepSeekApiKey(),
    streaming: options.streaming ?? false,
    configuration: {
      baseURL: deepseekBaseURL,
    },
  });
}

export async function invokeLangChainChat(messages: BaseMessage[]): Promise<string> {
  const chatModel = createLangChainChatModel();
  const response = await chatModel.invoke(messages);
  return messageContentToString(response.content);
}

export async function* streamLangChainChat(
  messages: BaseMessage[]
): AsyncGenerator<string> {
  const chatModel = createLangChainChatModel({ streaming: true });
  const stream = await chatModel.stream(messages);

  for await (const chunk of stream) {
    const delta = messageContentToString(chunk.content);

    if (delta) {
      yield delta;
    }
  }
}
