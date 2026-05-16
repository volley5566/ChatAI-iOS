import type { ScoredKnowledgeChunk } from "../shared/types";
import { retrieveLangChainKnowledge } from "../langchain/ragRetriever";

/**
 * 知识库外观层。
 *
 * 第一轮项目里，这个文件自己负责：
 * - 读取 Markdown
 * - 手写切 chunk
 * - 手写关键词打分
 *
 * 第二轮 LangChain 集成后，真正的 RAG 流程已经下沉到：
 *
 *   src/langchain/documentLoader.ts
 *   src/langchain/ragRetriever.ts
 *   src/langchain/embeddings.ts
 *
 * 这里保留 retrieveRelevantKnowledge / buildKnowledgeContext 这些老函数名，
 * 是为了让上层 chat、MCP、Agent 代码不需要关心底层到底是关键词检索
 * 还是 LangChain vector retriever。
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
