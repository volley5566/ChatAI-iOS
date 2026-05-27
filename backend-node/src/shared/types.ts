import type { BaseMessage } from "@langchain/core/messages";

/**
 * iOS 发给后端的聊天请求体。
 */
export type ChatRequestBody = {
  message?: string;
  system_prompt?: string;
  history?: ChatHistoryItem[];
  /**
   * Phase 5.3 新增:对话 ID。
   *
   * 用途:
   * - 后端有这个 id 就启用 LangGraph checkpointer,从数据库读历史 + 跑完写回
   * - 没传(undefined/缺字段)走"无持久化模式",和 Phase 4 一样靠 history 数组带历史
   *
   * 这样设计是为了**向后兼容**——老版本 iOS 不传 thread_id 仍能用,
   * 新版本 iOS 传了就自动享受持久化能力。
   *
   * iOS 端 Step 5.5 才会改 ChatViewModel 开始管理这个字段。
   *
   * 命名用 snake_case 是为了和现有字段(system_prompt)风格一致——
   * 这是 iOS → 后端的"HTTP 协议层"约定。
   */
  thread_id?: string;
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
 * Phase 10.1 #2 — iOS 提交用户反馈(👍/👎)的请求体。
 *
 * 字段约定:
 * - run_id: 对应某条 LangSmith trace 的根 run。iOS 从 SSE done 事件读到(#3 会加)
 * - score: 0..1 浮点。当前 iOS 只发 1(👍)或 0(👎),
 *   留浮点是给未来"星级 / LLM judge"扩展
 * - key: LangSmith 里 feedback 列名,可选;不传走后端默认 "user_thumb"
 * - comment: 可选用户备注,iOS 第一版不收集,留协议位置
 *
 * 命名同样用 snake_case,和现有 ChatRequestBody 风格对齐。
 */
export type FeedbackRequestBody = {
  run_id?: string;
  score?: number;
  key?: string;
  comment?: string;
};

export type FeedbackResponseBody = {
  feedback_id: string;
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
  /**
   * LangChain ChatDeepSeek 直接消费 BaseMessage[]。
   * 第一阶段开始，普通聊天接口不再把 prompt 转成 OpenAI SDK 的 messages；
   * 第二阶段后，Agent 也改由 LangChain createAgent 直接管理消息。
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
