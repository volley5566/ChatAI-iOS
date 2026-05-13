import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

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

export type ScoredKnowledgeDocument = {
  document: KnowledgeDocument;
  score: number;
};

export type ChatResponseMode = "structured" | "streaming";

export type PreparedChatCompletion = {
  knowledgeMatches: ScoredKnowledgeDocument[];
  aiMessages: ChatCompletionMessageParam[];
};

/**
 * 通过 SSE 发给 iOS 的事件格式。
 */
export type ChatStreamEvent =
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
    };

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
