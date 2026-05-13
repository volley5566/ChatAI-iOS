import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { buildRetrievalQuery } from "./chatHistory";
import { buildKnowledgeContext, retrieveRelevantKnowledge } from "./knowledge";
import { buildInstructions, buildStreamingInstructions } from "./prompts";
import type {
  ChatResponseMode,
  NormalizedChatHistoryItem,
  PreparedChatCompletion,
  ScoredKnowledgeDocument,
} from "./types";

/**
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

  const aiMessages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: instructions,
    },
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
  knowledgeMatches: ScoredKnowledgeDocument[],
  history: NormalizedChatHistoryItem[]
): void {
  console.log(
    `[RAG:${responseMode}] matched documents: ${
      knowledgeMatches
        .map((item) => `${item.document.fileName}:${item.score}`)
        .join(", ") || "none"
    }`
  );
  console.log(`[History:${responseMode}] messages sent to AI: ${history.length}`);
}
