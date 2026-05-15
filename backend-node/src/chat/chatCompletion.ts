import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { buildRetrievalQuery } from "./chatHistory";
import { buildKnowledgeContext, retrieveRelevantKnowledge } from "../knowledge/knowledge";
import { buildInstructions, buildStreamingInstructions } from "./prompts";
import type {
  ChatResponseMode,
  NormalizedChatHistoryItem,
  PreparedChatCompletion,
  ScoredKnowledgeChunk,
} from "../shared/types";

/**
 * 负责组装模型请求
 *
 * 组装一次 Chat Completions 请求需要的全部上下文。
 *
 * /api/chat 和 /api/chat/stream 共用这段逻辑：
 * - 根据“当前问题 + 历史”做 RAG 检索
 * - 把知识库命中结果拼成 system prompt
 * - 把 system、历史消息、当前用户问题组装成 messages
 */
export function prepareChatCompletion(
  message: string,
  systemPrompt: string | undefined,
  history: NormalizedChatHistoryItem[],
  responseMode: ChatResponseMode
): PreparedChatCompletion {
  const retrievalQuery = buildRetrievalQuery(message, history);
  const knowledgeMatches = retrieveRelevantKnowledge(retrievalQuery);
  const knowledgeContext = buildKnowledgeContext(knowledgeMatches);

  const instructions =
    responseMode === "streaming"
      ? buildStreamingInstructions(systemPrompt, knowledgeContext)
      : buildInstructions(systemPrompt, knowledgeContext);

  // 最终发给模型的是：
  // system prompt
  // 历史 user/assistant
  // 当前 user message
  const aiMessages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: instructions,
    },
    // 这里的 ...history.map(...) 是展开数组。
    ...history.map((item): ChatCompletionMessageParam => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user",
      content: message,
    },
  ];

  return {
    knowledgeMatches,
    aiMessages,
  };
}

/**
 * 打印 RAG 和 history 信息，方便在终端排查命中情况。
 */
export function logChatContext(
  responseMode: ChatResponseMode,
  knowledgeMatches: ScoredKnowledgeChunk[],
  history: NormalizedChatHistoryItem[]
): void {
  console.log(
    `[RAG:${responseMode}] matched chunks: ${
      knowledgeMatches
        .map((item) => `${item.chunk.citation}:${item.score}`)
        .join(", ") || "none"
    }`
  );
  console.log(`[History:${responseMode}] messages sent to AI: ${history.length}`);
}
