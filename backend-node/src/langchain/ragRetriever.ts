import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import {
  ragChunkOverlap,
  ragChunkSize,
  ragMinSimilarity,
  ragTopK,
} from "../config/env";
import type { KnowledgeChunk, ScoredKnowledgeChunk } from "../shared/types";
import { createLangChainEmbeddings } from "./embeddings";
import {
  loadKnowledgeDocuments,
  type KnowledgeDocumentMetadata,
} from "./documentLoader";

type IndexedKnowledgeMetadata = KnowledgeDocumentMetadata & {
  chunkId: string;
  chunkIndex: number;
  section: string;
  citation: string;
};

type LangChainRagIndex = {
  vectorStore: MemoryVectorStore;
  chunkCount: number;
  documentCount: number;
};

/**
 * 进程级 RAG 索引缓存。
 *
 * MemoryVectorStore 是内存向量库：
 * - 优点：零服务依赖、启动即用、适合学习和小知识库
 * - 缺点：进程重启后要重新建索引，不适合超大知识库
 *
 * 这里用 Promise 做缓存，是为了处理并发请求：
 * 如果两个用户同时发起第一条消息，只会构建一次索引。
 */
let ragIndexPromise: Promise<LangChainRagIndex> | undefined;

export async function retrieveLangChainKnowledge(
  query: string
): Promise<ScoredKnowledgeChunk[]> {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return [];
  }

  const index = await getLangChainRagIndex();

  if (index.chunkCount === 0) {
    return [];
  }

  /**
   * 这里是 LangChain RAG 的核心检索点：
   *
   * query 文本
   *   -> embeddings.embedQuery(query)
   *   -> MemoryVectorStore 计算相似度
   *   -> 返回最相近的 topK Documents + score
   *
   * 上层业务仍然拿到项目自己的 ScoredKnowledgeChunk，
   * 所以 HTTP route / MCP tool / iOS 都不需要知道底层已经换成 LangChain。
   */
  const results = await index.vectorStore.similaritySearchWithScore(
    trimmedQuery,
    ragTopK
  );

  return results
    .filter(([, score]) => {
      return Number.isFinite(score) && score >= ragMinSimilarity;
    })
    .map(([document, score]) => ({
      chunk: documentToKnowledgeChunk(document),
      score: normalizeSimilarityScore(score),
    }));
}

async function getLangChainRagIndex(): Promise<LangChainRagIndex> {
  if (!ragIndexPromise) {
    ragIndexPromise = buildLangChainRagIndex().catch((error: unknown) => {
      /**
       * 如果构建失败，清空缓存。
       * 这样修复知识库文件或配置后，下一次请求还有机会重新构建，
       * 而不是永远复用一个 rejected promise。
       */
      ragIndexPromise = undefined;
      throw error;
    });
  }

  return ragIndexPromise;
}

async function buildLangChainRagIndex(): Promise<LangChainRagIndex> {
  const documents = await loadKnowledgeDocuments();

  /**
   * RecursiveCharacterTextSplitter 是 LangChain 最常用的文本切分器之一。
   *
   * fromLanguage("markdown") 会优先按 Markdown 语义边界切：
   * - 标题
   * - 空行
   * - 段落
   * - 最后才按字符兜底
   *
   * 这比“每 N 个字符切一刀”更适合学习文档。
   */
  const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
    chunkSize: ragChunkSize,
    chunkOverlap: ragChunkOverlap,
  });

  const splitDocuments = await splitter.splitDocuments(documents);
  const indexedDocuments = addChunkMetadata(splitDocuments);
  const embeddings = createLangChainEmbeddings();
  const vectorStore = await MemoryVectorStore.fromDocuments(indexedDocuments, embeddings);

  console.error(
    `[LangChain RAG] Loaded ${documents.length} documents, ` +
      `${indexedDocuments.length} chunks, topK=${ragTopK}, ` +
      `chunkSize=${ragChunkSize}, chunkOverlap=${ragChunkOverlap}.`
  );

  return {
    vectorStore,
    documentCount: documents.length,
    chunkCount: indexedDocuments.length,
  };
}

function addChunkMetadata(documents: Document[]): Document<IndexedKnowledgeMetadata>[] {
  const chunkCountersByFileName = new Map<string, number>();

  return documents
    .map((document) => {
      /**
       * splitDocuments 会保留 metadata，但 TypeScript 类型会退化成
       * Record<string, any>。这里把它还原成我们自己的 metadata 类型，
       * 让后面的 fileName/title/keywords 都有清晰语义。
       */
      const metadata = document.metadata as KnowledgeDocumentMetadata;
      const fileName = metadata.fileName;
      const nextChunkIndex = (chunkCountersByFileName.get(fileName) || 0) + 1;
      chunkCountersByFileName.set(fileName, nextChunkIndex);

      const section = extractSection(document.pageContent, metadata.title);
      const citation = `${section} (${fileName})`;
      const chunkId = `${fileName}#langchain-chunk-${nextChunkIndex}`;

      return new Document<IndexedKnowledgeMetadata>({
        pageContent: document.pageContent.trim(),
        metadata: {
          ...metadata,
          chunkId,
          chunkIndex: nextChunkIndex,
          section,
          citation,
        },
      });
    })
    .filter((document) => document.pageContent.length > 0);
}

function extractSection(content: string, fallbackTitle: string): string {
  /**
   * LangChain splitter 会保留 chunk 中的 Markdown 标题。
   * 如果当前 chunk 里能找到标题，就用第一个标题作为 section。
   * 如果没有标题，说明这是某个长小节的中间片段，就退回文档标题。
   */
  const headingMatch = content.match(/^(#{1,6})\s+(.+)$/m);
  return headingMatch?.[2]?.trim() || fallbackTitle;
}

function documentToKnowledgeChunk(document: Document): KnowledgeChunk {
  const metadata = document.metadata as IndexedKnowledgeMetadata;

  return {
    id: metadata.chunkId,
    fileName: metadata.fileName,
    title: metadata.title,
    section: metadata.section,
    citation: metadata.citation,
    keywords: metadata.keywords,
    content: document.pageContent,
  };
}

function normalizeSimilarityScore(score: number): number {
  /**
   * MemoryVectorStore 返回的是 cosine similarity，通常在 0..1。
   * 这里保留 4 位小数，日志更容易读，也避免把一长串浮点数传来传去。
   */
  return Math.round(score * 10000) / 10000;
}
