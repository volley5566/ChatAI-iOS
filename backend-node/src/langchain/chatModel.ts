import { ChatDeepSeek } from "@langchain/deepseek";
import type { BaseMessage } from "@langchain/core/messages";
import { deepseekBaseURL, model, requireDeepSeekApiKey } from "../config/env";
import { messageContentToString } from "./chatPrompt";

type CreateLangChainChatModelOptions = {
  streaming?: boolean;
  disableThinking?: boolean;
  disableParallelToolCalls?: boolean;
};

/**
 * LangChain DeepSeek chat model 工厂。
 *
 * 现在普通 RAG 聊天会走：
 *
 *   ChatPromptTemplate -> BaseMessage[] -> ChatDeepSeek
 *
 * Agent 接口也会复用这个工厂创建 streaming model，
 * 再交给 LangChain createAgent 管理工具决策和最终输出。
 *
 * 这种拆法的目标是：
 * - 所有 DeepSeek 调用统一从这里创建
 * - 普通 RAG 和 Agent 链路都使用同一套 LangChain model 配置
 */
export function createLangChainChatModel(
  options: CreateLangChainChatModelOptions = {}
): ChatDeepSeek {
  return new ChatDeepSeek({
    model,
    apiKey: requireDeepSeekApiKey(),
    streaming: options.streaming ?? false,
    /**
     * modelKwargs 会被 @langchain/openai 原样合并到 Chat Completions 请求体。
     *
     * Agent 工具链路会打开两个额外选项：
     * - thinking disabled：避免 DeepSeek thinking mode 要求下一轮回传 reasoning_content。
     *   当前 LangChain OpenAI converter 能读取 reasoning_content，但不会在下一轮请求中带回。
     * - parallel_tool_calls false：当前学习项目希望一轮只执行一个工具，方便日志和 iOS UI 对齐。
     *
     * 普通 /api/chat 和 /api/chat/stream 不需要这些限制，所以默认不设置。
     */
    modelKwargs: buildDeepSeekModelKwargs(options),
    configuration: {
      baseURL: deepseekBaseURL,
    },
  });
}

function buildDeepSeekModelKwargs(
  options: CreateLangChainChatModelOptions
): Record<string, unknown> {
  const modelKwargs: Record<string, unknown> = {};

  if (options.disableThinking) {
    modelKwargs.thinking = {
      type: "disabled",
    };
  }

  if (options.disableParallelToolCalls) {
    modelKwargs.parallel_tool_calls = false;
  }

  return modelKwargs;
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
