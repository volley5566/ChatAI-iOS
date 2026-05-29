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
 * ═══════════════════════════════════════════════════════════════════
 * chat/chatCompletion.ts — 普通聊天的请求组装(/api/chat 和 /api/chat/stream)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   server.ts → prepareChatCompletion → 拿到 langChainMessages → 喂给 ChatDeepSeek
 *
 * # 这一层做什么
 *   1. 根据"当前问题 + 历史"构造 RAG 检索 query
 *   2. 检索知识库,拼成 knowledge context
 *   3. 把 system prompt + context + 历史 + 当前问题组装成 BaseMessage[]
 *   4. 返回给 server.ts,server.ts 喂给 ChatDeepSeek
 *
 * 注意:这条路径不走 Agent,纯 RAG。Agent 路径在 /api/agent/stream。
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

  // 用 ChatPromptTemplate 组装 BaseMessage[]——
  // ChatDeepSeek 最自然的输入格式,和 Agent createAgent 的消息体系保持一致。
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
