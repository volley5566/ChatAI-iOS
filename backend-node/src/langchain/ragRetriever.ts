import path from "path";
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
import {
  createLangChainEmbeddings,
  getEmbeddingsIdentity,
} from "./embeddings";
import {
  loadKnowledgeDocuments,
  type KnowledgeDocumentMetadata,
} from "./documentLoader";
import {
  computeFingerprint,
  loadCache,
  saveCache,
  type CacheEntry,
} from "./ragCache";

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/ragRetriever.ts — 向量检索入口(LangChain MemoryVectorStore)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   knowledge.ts / agentTools(searchKnowledge) → retrieveLangChainKnowledge
 *   → embedQuery + MemoryVectorStore.similaritySearchWithScore
 *
 * # 这一层做什么
 *   1. 启动时把 markdown 文档 chunk 化 + embedding 化
 *   2. 命中磁盘缓存就跳过 embedding(冷启动 2-5s → <100ms)
 *   3. 查询时把用户问题 embed 成向量,找余弦相似度最高的 topK chunks
 *
 * # 进程级 Promise 缓存
 *   MemoryVectorStore 在内存里:
 *     优点 → 零服务依赖、启动即用、适合学习和小知识库
 *     缺点 → 进程重启后要重建,不适合超大知识库
 *   用 Promise 缓存处理并发:两个用户同时第一次发消息只会构建一次索引。
 */

// 向量缓存文件路径,放在 backend-node/.rag-cache/(已 .gitignore)

const ragCachePath = path.resolve(__dirname, "../../.rag-cache/vectors.json");

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

// 进程级 RAG 索引缓存(Promise 形式,处理并发初始化)
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
   * 这比"每 N 个字符切一刀"更适合学习文档。
   */
  const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
    chunkSize: ragChunkSize,
    chunkOverlap: ragChunkOverlap,
  });

  const splitDocuments = await splitter.splitDocuments(documents);
  const indexedDocuments = addChunkMetadata(splitDocuments);
  const embeddings = createLangChainEmbeddings();
  const embeddingIdentity = getEmbeddingsIdentity();

  /**
   * 先算指纹试缓存。
   *
   * 指纹覆盖:
   *   - embedding 标识(换模型必须重建)
   *   - chunk 切分参数(切得不一样,向量对不上)
   *   - 每个 chunk 的 fileName + 实际文本内容
   *
   * 注意用的是切完后的 indexedDocuments,不是原始文档:
   * splitter 自己也可能升级算法,直接对最终 chunk 内容做 hash
   * 才能完整描述"这些向量代表什么"。
   */
  const fingerprint = computeFingerprint({
    embeddingIdentity,
    chunkSize: ragChunkSize,
    chunkOverlap: ragChunkOverlap,
    documents: indexedDocuments.map((document) => ({
      fileName: document.metadata.fileName,
      content: document.pageContent,
    })),
  });

  const cachedEntries = await loadCache(ragCachePath, fingerprint);

  let vectorStore: MemoryVectorStore;
  let buildSource: "cache" | "fresh";

  if (cachedEntries) {
    /**
     * 缓存命中:跳过 embedding,直接把(向量, 文档)塞给空 store。
     *
     * MemoryVectorStore 的 addVectors API 就是干这个的——
     * 接受预计算的向量数组,不会回头去 embed 一遍。
     * 查询时的 embedQuery 还是会照常调 Ollama(这部分必须实时算)。
     */
    vectorStore = new MemoryVectorStore(embeddings);
    await vectorStore.addVectors(
      cachedEntries.map((entry) => entry.vector),
      cachedEntries.map(
        (entry) =>
          new Document({
            pageContent: entry.pageContent,
            metadata: entry.metadata,
          })
      )
    );
    buildSource = "cache";
  } else {
    /**
     * 缓存未命中:正常构建,再把(向量, 文档)写回磁盘。
     *
     * MemoryVectorStore.fromDocuments 内部会调 embeddings.embedDocuments,
     * 30-50 个 chunk × Ollama ~50ms ≈ 2-5 秒。这就是我们要缓存掉的开销。
     */
    vectorStore = await MemoryVectorStore.fromDocuments(
      indexedDocuments,
      embeddings
    );
    buildSource = "fresh";

    /**
     * 从 vectorStore 内部把"已嵌入向量"挖出来写缓存。
     *
     * memoryVectors 是 LangChain 暴露的实现细节。这里直接读取,
     * 是因为它是当前最稳定的"拿到 chunk 对应向量"的途径——
     * 也可以分两步(先 embedDocuments 再 addVectors),但那样要重复管理一份。
     */
    const entriesToCache: CacheEntry[] = vectorStore.memoryVectors.map(
      (vector) => ({
        vector: vector.embedding,
        pageContent: vector.content,
        metadata: vector.metadata,
      })
    );

    const dimensions = entriesToCache[0]?.vector.length ?? 0;

    /**
     * 写缓存放在 try 外面是故意的——
     * 即便写盘失败(权限/磁盘满),内存里 vectorStore 已经构建好了,
     * 业务请求仍能正常服务,下次重启再试着写就行。
     */
    try {
      await saveCache(ragCachePath, {
        fingerprint,
        createdAt: new Date().toISOString(),
        embeddingIdentity,
        dimensions,
        entryCount: entriesToCache.length,
        chunkSize: ragChunkSize,
        chunkOverlap: ragChunkOverlap,
        entries: entriesToCache,
      });
    } catch (error) {
      console.error("[RAG cache] save failed (non-fatal):", error);
    }
  }

  console.error(
    `[LangChain RAG] (${buildSource}) Loaded ${documents.length} documents, ` +
      `${indexedDocuments.length} chunks, topK=${ragTopK}, ` +
      `chunkSize=${ragChunkSize}, chunkOverlap=${ragChunkOverlap}, ` +
      `embedding=${embeddingIdentity}.`
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
