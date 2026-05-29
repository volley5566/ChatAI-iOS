/**
 * ═══════════════════════════════════════════════════════════════════
 * shared/types.ts — 后端共享类型定义
 * ═══════════════════════════════════════════════════════════════════
 *
 * 所有模块共用的 TypeScript 类型集中在这里,避免循环依赖。
 * 字段命名用 snake_case,和 iOS ↔ 后端 HTTP 协议风格一致。
 */

import type { BaseMessage } from "@langchain/core/messages";

// ─── HTTP 请求/响应体 ──────────────────────────────────────────

/** iOS 发给后端的聊天请求体(三个接口共用) */
export type ChatRequestBody = {
  message?: string;
  system_prompt?: string;
  history?: ChatHistoryItem[];
  /**
   * 对话 ID。
   * 传了 → 启用 LangGraph checkpointer,后端管理对话历史
   * 没传 → 无持久化模式,靠 history 数组带历史(向后兼容老版本 iOS)
   */
  thread_id?: string;
};

/** /api/chat 非流式接口的返回格式 */
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
 * iOS 提交用户反馈(👍/👎)的请求体。
 *   run_id  — 对应 LangSmith trace 的根 run(从 SSE done 事件拿到)
 *   score   — 0..1 浮点, 👍=1 / 👎=0,留浮点给未来星级扩展
 *   key     — LangSmith feedback 列名,不传走默认 "user_thumb"
 *   comment — 用户备注(可选,iOS 第一版不收集,留协议位置)
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

// ─── 对话历史 ──────────────────────────────────────────────────

/** iOS 发来的原始历史消息(字段可选,外部输入不能完全信任) */
export type ChatHistoryItem = {
  role?: string;
  content?: string;
};

/** 清洗后真正发给模型的历史消息(role 收窄到 user | assistant) */
export type NormalizedChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

// ─── 知识库 / RAG ──────────────────────────────────────────────

export type KnowledgeDocument = {
  fileName: string;
  title: string;
  keywords: string[];
  content: string;
};

/**
 * Markdown 文档切出来的一小段知识片段。
 *
 * 为什么要切 chunk:
 *   一篇 Markdown 包含多个主题,整篇塞给模型会带大量无关内容。
 *   用户问题通常只命中一两个小节,按 chunk 存向量检索更精准。
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

// ─── 聊天模式 / LangChain 消息 ────────────────────────────────

export type ChatResponseMode = "structured" | "streaming";

export type PreparedChatCompletion = {
  knowledgeMatches: ScoredKnowledgeChunk[];
  /** LangChain ChatDeepSeek 直接消费 BaseMessage[] */
  langChainMessages: BaseMessage[];
};

// ─── SSE 事件格式(通过 Server-Sent Events 发给 iOS) ──────────

type ChatStreamEventMetadata = {
  /** 后端为每次 Agent 请求生成的链路 ID,排查问题时和后端日志对齐用 */
  request_id?: string;
  phase?: string;
  duration_ms?: number;
};

/**
 * 所有 SSE 事件的联合类型。iOS 根据 type 字段做模式匹配:
 *
 *   delta       → 追加文本到 AI 气泡
 *   done        → 回答结束(附 run_id + token 用量)
 *   error       → 显示错误
 *   tool_start  → 显示"正在查询知识库..."
 *   tool_done   → 更新"已查询,找到 N 条"
 */
export type ChatStreamEvent = ChatStreamEventMetadata &
  (
    | { type: "delta"; delta: string }
    | {
        type: "done";
        /**
         * LangSmith 根 run UUID。iOS 存起来,用户点 👍/👎 时回传给 /api/feedback。
         * 可选: LangSmith 关掉时行为等价于没 id,前端反馈按钮自然降级隐藏。
         */
        run_id?: string;
        /**
         * 本次 Agent 请求消耗的 token 用量(所有 ReAct 循环中模型调用的累加值):
         *   prompt_tokens     — input token 总和
         *   completion_tokens — output token 总和
         *   total_tokens      — prompt + completion
         *
         * iOS 可以用来展示"本次消耗多少 token"或做成本统计。
         */
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
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
