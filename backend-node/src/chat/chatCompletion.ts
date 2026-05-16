import { buildRetrievalQuery } from "./chatHistory";
import { buildKnowledgeContext, retrieveRelevantKnowledge } from "../knowledge/knowledge";
import { buildInstructions, buildStreamingInstructions } from "./prompts";
import { buildLangChainRagMessages } from "../langchain/chatPrompt";
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
export async function prepareChatCompletion(
  message: string,
  systemPrompt: string | undefined,
  history: NormalizedChatHistoryItem[],
  responseMode: ChatResponseMode
): Promise<PreparedChatCompletion> {
  const retrievalQuery = buildRetrievalQuery(message, history);
  const knowledgeMatches = await retrieveRelevantKnowledge(retrievalQuery);
  const knowledgeContext = buildKnowledgeContext(knowledgeMatches);

  const instructions =
    responseMode === "streaming"
      ? buildStreamingInstructions(systemPrompt, knowledgeContext)
      : buildInstructions(systemPrompt, knowledgeContext);

  /**
   * 第二轮 LangChain 集成后，普通聊天的 prompt 组装交给 ChatPromptTemplate。
   *
   * LangChain 输出 BaseMessage[]，这是 ChatDeepSeek 最自然的输入格式，
   * 也能和 Agent createAgent 的消息体系保持一致。
   */
  const langChainMessages = await buildLangChainRagMessages(
    instructions,
    history,
    message
  );

  return {
    knowledgeMatches,
    langChainMessages,
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
