import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * iOS 发给后端的聊天请求体。
 */
export type ChatRequestBody = {
  message?: string;
  system_prompt?: string;
  history?: ChatHistoryItem[];
};

export type ChatResponseBody = {
  title: string;
  summary: string;
  points: string[];
  next_question: string;
};

export type ErrorResponseBody = {
  error: string;
};

/**
 * iOS 发来的原始历史消息。
 *
 * 字段保持可选，因为外部请求不能完全相信。
 */
export type ChatHistoryItem = {
  role?: string;
  content?: string;
};

/**
 * 清洗后真正发给模型的历史消息。
 */
export type NormalizedChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type KnowledgeDocument = {
  fileName: string;
  title: string;
  keywords: string[];
  content: string;
};

/**
 * Markdown 文档切出来的一小段知识片段。
 *
 * 为什么需要 chunk：
 * - 一篇 Markdown 往往包含多个主题，整篇塞给模型会带很多无关内容
 * - 用户问题通常只命中其中一两个小节
 * - 后续接 embedding/vector search 时，向量也应该按 chunk 存，而不是按整篇文档存
 */
export type KnowledgeChunk = {
  id: string;
  fileName: string;
  title: string;
  section: string;
  citation: string;
  keywords: string[];
  content: string;
};

export type ScoredKnowledgeChunk = {
  chunk: KnowledgeChunk;
  score: number;
};

export type ChatResponseMode = "structured" | "streaming";

export type PreparedChatCompletion = {
  knowledgeMatches: ScoredKnowledgeChunk[];
  aiMessages: ChatCompletionMessageParam[];
  /**
   * LangChain ChatDeepSeek 直接消费 BaseMessage[]。
   * aiMessages 暂时保留给 OpenAI-compatible SDK 和 Agent 过渡层使用。
   */
  langChainMessages: BaseMessage[];
};

type ChatStreamEventMetadata = {
  /**
   * 后端为每次 Agent 请求生成的 trace id。
   * iOS 可以忽略它，但排查问题时可以用它和后端日志对齐。
   */
  request_id?: string;
  phase?: string;
  duration_ms?: number;
};

/**
 * 通过 SSE 发给 iOS 的事件格式。
 */
export type ChatStreamEvent = ChatStreamEventMetadata &
  (
    | { type: "delta"; delta: string }
    | { type: "done" }
    | { type: "error"; error: string }
    | {
        type: "tool_start";
        tool_call_id: string;
        tool_name: string;
        display_name: string;
        message: string;
      }
    | {
        type: "tool_done";
        tool_call_id: string;
        tool_name: string;
        display_name: string;
        ok: boolean;
        message: string;
      }
  );

/**
 * DeepSeek V4 thinking mode 会在 assistant 消息里额外返回 reasoning_content。
 *
 * OpenAI SDK 的通用类型目前不包含这个 DeepSeek 扩展字段，
 * 但 DeepSeek 官方要求 tool call 下一轮必须原样带回。
 */
export type DeepSeekAssistantMessageWithReasoning =
  ChatCompletionAssistantMessageParam & {
    reasoning_content?: string | null;
  };
