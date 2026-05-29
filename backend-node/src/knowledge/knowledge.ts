import type { ScoredKnowledgeChunk } from "../shared/types";
import { retrieveLangChainKnowledge } from "../langchain/ragRetriever";

/**
 * ═══════════════════════════════════════════════════════════════════
 * knowledge/knowledge.ts — 知识库外观层(facade)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   chatCompletion.ts / mcpToolHandlers(searchKnowledge)
 *     ↓
 *   retrieveRelevantKnowledge  ← 这个文件
 *     ↓
 *   langchain/ragRetriever.ts(真正的 RAG 实现)
 *
 * # 为什么保留这一层
 *   早期项目里这个文件自己读 Markdown / 切 chunk / 关键词打分,
 *   后来 RAG 全下沉到 langchain/ 目录,但保留这层老接口:
 *     - 上层 chat / MCP / Agent 不用关心底层是关键词检索还是 vector retriever
 *     - 加 buildKnowledgeContext 这种"把 chunks 排版成 prompt context"的胶水逻辑
 */

const maxCharactersPerChunk = 1600;
const maxKnowledgeContextCharacters = 7000;

/**
 * 根据用户问题检索最相关的知识库 chunk。
 *
 * 注意：现在它是 async。
 * 因为 LangChain retriever 需要：
 * - 首次请求时异步加载 Markdown
 * - 异步切分文档
 * - 异步构建 MemoryVectorStore
 * - 异步执行 similarity search
 */
export async function retrieveRelevantKnowledge(
  question: string
): Promise<ScoredKnowledgeChunk[]> {
  return retrieveLangChainKnowledge(question);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...`;
}

/**
 * 把检索到的 chunks 整理成 prompt 里的 context。
 *
 * LangChain 负责“找资料”，这个函数负责“把资料喂给模型前排版”。
 * 这样职责会比较清楚：
 * - retriever：决定哪些 chunk 相关
 * - context builder：决定这些 chunk 在 system prompt 里长什么样
 */
export function buildKnowledgeContext(
  matches: ScoredKnowledgeChunk[]
): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  let context = "";

  for (const match of matches) {
    const nextBlock = `
[Source: ${match.chunk.fileName}]
[Title: ${match.chunk.title}]
[Section: ${match.chunk.section}]
[Citation: ${match.chunk.citation}]
[LangChain similarity: ${match.score}]

${truncateText(match.chunk.content, maxCharactersPerChunk)}
`;

    if ((context + nextBlock).length > maxKnowledgeContextCharacters) {
      break;
    }

    context += nextBlock;
  }

  return context.trim();
}
