/**
 * ═══════════════════════════════════════════════════════════════════
 * chat/chatHistory.ts — iOS 历史消息清洗 + RAG 检索 query 组装
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   server.ts → sanitizeChatHistory(req.body.history) → 安全的历史数组
 *             → buildRetrievalQuery → RAG retriever
 *
 * # 为什么要清洗
 *   iOS 是外部输入,不能完全信任:
 *     - 限制 role 只能是 user / assistant(防止伪造 system / tool)
 *     - 限制每条 content 长度(防止单条消息把 prompt 撑爆)
 *     - 限制总消息数(避免 token 无限增长)
 */

import type { ChatHistoryItem, NormalizedChatHistoryItem } from "../shared/types";

/** 每次最多带多少条历史消息 */
const maxHistoryMessages = 6;

/** 每条历史消息最多保留多少字符,避免请求无限变大 */
const maxHistoryContentCharacters = 1200;

function truncateHistoryContent(content: string): string {
  if (content.length <= maxHistoryContentCharacters) {
    return content;
  }

  return `${content.slice(0, maxHistoryContentCharacters)}\n...`;
}

/**
 * 清洗 iOS 传来的 history。
 *
 * 只允许 user / assistant 进入模型上下文，避免客户端通过 history
 * 注入 system / tool 等后端不希望接受的角色。
 */
export function sanitizeChatHistory(history: unknown): NormalizedChatHistoryItem[] {
  if (!Array.isArray(history)) {
    return [];
  }

  const normalizedHistory = history
    .map((item): NormalizedChatHistoryItem | undefined => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const historyItem = item as ChatHistoryItem;
      const role = historyItem.role;
      const content = historyItem.content;

      // 安全边界:只允许 user / assistant,不接受客户端伪造的 system / tool
      if (role !== "user" && role !== "assistant") {
        return undefined;
      }

      if (typeof content !== "string") {
        return undefined;
      }

      const trimmedContent = content.trim();

      if (!trimmedContent) {
        return undefined;
      }

      return {
        role,
        content: truncateHistoryContent(trimmedContent),
      };
    })
    .filter((item): item is NormalizedChatHistoryItem => Boolean(item));

  return normalizedHistory.slice(-maxHistoryMessages);
}

/**
 * RAG 检索使用“历史 + 当前问题”。
 *
 * 这样用户追问“继续”“举个例子”时，检索仍能看到上一轮关键词。
 */
export function buildRetrievalQuery(
  message: string,
  history: NormalizedChatHistoryItem[]
): string {
  const historyText = history.map((item) => item.content).join("\n");

  return `${historyText}\n${message}`.trim();
}
