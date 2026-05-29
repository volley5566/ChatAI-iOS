import { Embeddings } from "@langchain/core/embeddings";

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/localEmbeddings.ts — 学习版假 Embeddings(无外部依赖)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   embeddings.ts 在 EMBEDDINGS_PROVIDER=local-keyword 时返回这个实现。
 *
 * # 为什么保留它
 *   生产项目用 OpenAI embeddings / bge / e5 / jina 等真模型,
 *   本项目默认走 Ollama 真 embedding。但保留这个"零依赖"版本是为了:
 *     - 没装 Ollama 的人能看 LangChain RAG 流程跑通
 *     - 离线 / CI 环境
 *
 * # 它做什么
 *   - 不联网、不下载模型
 *   - 把中英文关键词 hash 到固定维度向量里
 *   - 交给 LangChain MemoryVectorStore 做 cosine similarity
 *
 * 效果介于"关键词检索"和"真正语义向量检索"之间。
 * 不适合作为最终生产级语义检索,只适合学习架构。
 */
export class LocalKeywordEmbeddings extends Embeddings {
  /**
   * 向量维度。
   *
   * 维度越大，hash 冲突越少；维度越小，计算越轻。
   * 当前知识库很小，512 维已经足够学习和本地调试。
   */
  private readonly dimensions: number;

  constructor(dimensions = 512) {
    super({});
    this.dimensions = dimensions;
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    return documents.map((document) => this.embedText(document));
  }

  async embedQuery(document: string): Promise<number[]> {
    return this.embedText(document);
  }

  private embedText(text: string): number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const weightedTerms = extractWeightedTerms(text);

    for (const { term, weight } of weightedTerms) {
      const index = hashTerm(term) % this.dimensions;
      vector[index] += weight;
    }

    /**
     * MemoryVectorStore 默认用 cosine similarity。
     * cosine similarity 对向量长度敏感，所以这里做 L2 normalize：
     * 让“长文档因为词多而天然占优”的影响变小。
     */
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

    if (magnitude === 0) {
      return vector;
    }

    return vector.map((value) => value / magnitude);
  }
}

type WeightedTerm = {
  term: string;
  weight: number;
};

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "what",
  "why",
  "how",
  "this",
  "that",
  "is",
  "are",
  "was",
  "were",
  "什么",
  "怎么",
  "如何",
  "为什么",
  "这个",
  "那个",
  "区别",
]);

function extractWeightedTerms(text: string): WeightedTerm[] {
  const normalizedText = text.toLowerCase();
  const terms: WeightedTerm[] = [];

  /**
   * 英文 / Swift / API 名称：
   * - @State
   * - URLSession
   * - tool_call
   * - OpenAI-compatible
   *
   * 这些词对当前 iOS + AI 学习知识库很重要，所以单独保留。
   */
  const latinTerms =
    normalizedText.match(/[@#]?[a-z0-9_+.-]+/g)?.filter((term) => {
      return term.length >= 2 && !stopWords.has(term);
    }) || [];

  for (const term of latinTerms) {
    terms.push({
      term,
      weight: term.startsWith("@") ? 1.6 : 1,
    });
  }

  /**
   * 中文没有空格分词。
   *
   * 为了不引入额外分词库，这里用 2-gram / 3-gram：
   * “状态管理”会变成 “状态”“态管”“管理”“状态管”“态管理”。
   *
   * 这不是语义模型，但对本项目里的中文问题已经比整句硬匹配稳定很多。
   */
  const chineseSequences = normalizedText.match(/[\u4e00-\u9fff]+/g) || [];

  for (const sequence of chineseSequences) {
    if (sequence.length === 1 && !stopWords.has(sequence)) {
      terms.push({ term: sequence, weight: 0.8 });
      continue;
    }

    for (const size of [2, 3]) {
      for (let index = 0; index <= sequence.length - size; index += 1) {
        const term = sequence.slice(index, index + size);

        if (!stopWords.has(term)) {
          terms.push({
            term,
            weight: size === 3 ? 1.2 : 1,
          });
        }
      }
    }
  }

  return terms;
}

function hashTerm(term: string): number {
  /**
   * FNV-1a 是一个很小的稳定 hash。
   *
   * 这里不能用 Math.random 或 JS 对象地址之类的东西，
   * 因为同一段文本每次启动都必须得到同一个向量，否则检索结果无法复现。
   */
  let hash = 2166136261;

  for (let index = 0; index < term.length; index += 1) {
    hash ^= term.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}
