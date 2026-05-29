import { ChatDeepSeek } from "@langchain/deepseek";
import type { BaseMessage } from "@langchain/core/messages";
import {
  chatModelHttpMaxRetries,
  deepseekBaseURL,
  model,
  requireDeepSeekApiKey,
} from "../config/env";
import { messageContentToString } from "./chatPrompt";

type CreateLangChainChatModelOptions = {
  streaming?: boolean;
  disableThinking?: boolean;
  disableParallelToolCalls?: boolean;
};

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/chatModel.ts — ChatDeepSeek 实例工厂(项目唯一出口)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   所有需要调 DeepSeek 的代码(普通 RAG / Agent / Eval)都从这里拿模型实例。
 *
 * # 为什么集中创建?
 *   - 配置统一(model 名、apiKey、baseURL、重试次数都从 env 读)
 *   - 切换模型只改一处
 *   - 测试时容易 mock
 *
 * # 三种调用方式
 *   - createLangChainChatModel(opts)  → 拿到 ChatDeepSeek 实例自己用
 *   - invokeLangChainChat(messages)   → 一次性拿完整回答
 *   - streamLangChainChat(messages)   → AsyncGenerator,边产边消费
 */
export function createLangChainChatModel(
  options: CreateLangChainChatModelOptions = {}
): ChatDeepSeek {
  /**
   * ChatDeepSeek 内部继承自 ChatOpenAI(DeepSeek 用的是 OpenAI 兼容 API)。
   * streaming: true 让底层 SDK 走 /v1/chat/completions 的 SSE 模式,
   * 这样 .stream() 才能一个 chunk 一个 chunk 吐出来。
   */
  return new ChatDeepSeek({
    model,
    apiKey: requireDeepSeekApiKey(),
    streaming: options.streaming ?? false,
    /**
     * maxRetries 是 @langchain/openai 在 HTTP 层做的自动重试:
     * 单次 fetch 失败 / 429 / 5xx 时按指数退避重试,最多这么多次。
     *
     * 注意它和 Agent 里挂的 modelRetryMiddleware 是"两层重试":
     *   - 这里 maxRetries   → 包住一次模型 SDK 调用,针对网络/瞬时错误
     *   - middleware 层     → 包住整个 model node,针对一轮决策失败
     *
     * 叠在一起才是"可观测 + 可恢复"的标准做法。
     * 实际重试上限大致是 chatModelHttpMaxRetries × (agentModelRetryMaxAttempts + 1),
     * 默认 2 × 3 = 6 次,够覆盖偶发抖动又不会无限循环。
     */
    maxRetries: chatModelHttpMaxRetries,// HTTP 层重试
    /**
     * modelKwargs 会被原样合并到 Chat Completions 请求体。
     *
     * Agent 链路会打开两个额外选项:
     *   - thinking disabled  → 避免 DeepSeek thinking 模式要求下一轮回传 reasoning_content
     *     (当前 converter 能读但不会在下一轮请求中带回,会导致 API 报错)
     *   - parallel_tool_calls false → 一轮只执行一个工具,方便日志和 iOS UI 对齐
     *
     * 普通 /api/chat 和 /api/chat/stream 不需要这些限制,所以默认不设置。
     */
    modelKwargs: buildDeepSeekModelKwargs(options),// thinking=disabled 等
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
