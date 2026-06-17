import { prisma } from "../db/prisma";
import {
  createLangChainEmbeddings,
  getEmbeddingsIdentity,
} from "../langchain/embeddings";

/**
 * ═══════════════════════════════════════════════════════════════════
 * memory/memoryStore.ts — 跨对话长期记忆的"档案柜的门"(Phase 12 #2)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   (现在) 只被 memoryStoreDebug.ts 调用,验证存取链路
 *   (Phase 12 #3) recallMemoriesNode 调 searchMemories 把记忆喂给模型
 *   (Phase 12 #4) memoryWriter 调 putMemory 把提炼出的要点入库
 *
 * # 这一层负责什么、不负责什么
 *   负责:  纯粹的 CRUD + 语义检索。给我 userId / 内容,我帮你存;
 *          给我 userId / 一句话,我帮你按语义找出最相关的几条。
 *   不负责: "什么值得记""怎么去重""什么时候记"——那些是 Phase 12 #4
 *          memoryWriter 的判断逻辑。这一层只做"存"和"取",不做"决策"。
 *
 *   这种分层和 Phase 6 RAG 一样:ragRetriever 只管检索,
 *   "检索出来怎么拼 prompt"是 agent 的事。职责单一,好测好换。
 *
 * # 为什么检索在应用层用 JS 算余弦,而不是用数据库
 *   SQLite 没有原生向量检索(没有 pgvector 那种扩展)。所以这里沿用
 *   项目里 MemoryVectorStore 的同款做法:把候选记忆的向量读进内存,
 *   逐条算 cosine similarity,排序取 topK。
 *   学习项目每个用户的记忆量级在几十~几百条,暴力算完全够快。
 *   真要上规模,把这张表迁到 Postgres + pgvector,只改这一个文件。
 */

/**
 * 记忆的三种类型(认知科学经典分类,Mem0 / LangMem 同款):
 *   semantic   关于用户/世界的稳定事实   "用户在学 SwiftUI"
 *   episodic   过去发生的具体事件        "上周 @State 答错了,得 1 分"
 *   procedural 偏好 / 做事规则           "喜欢先看代码再看解释"
 */
export type MemoryKind = "semantic" | "episodic" | "procedural";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "semantic",
  "episodic",
  "procedural",
];

/** 一条记忆(对外暴露的形状,不含原始 embedding 二进制)。 */
export type MemoryRecord = {
  id: string;
  userId: string;
  kind: MemoryKind;
  content: string;
  sourceThreadId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 检索命中:在 MemoryRecord 基础上多一个相似度分数(0..1,越大越相关)。 */
export type MemorySearchHit = MemoryRecord & { score: number };

// ─── 写入 ─────────────────────────────────────────────────────────

/**
 * 存一条记忆。
 *
 * 流程:校验 kind → 算 embedding 向量 → 序列化成 BLOB → 写库。
 *
 * embedding 失败不致命:catch 住,记忆仍然落库(embedding 留空),
 * 只是这条暂时不能被向量检索到——事后可补算。Phase 12 这一版先不做补算,
 * 但表结构(embedding 可空 + embeddingModel)已经为补算留好了口子。
 */
export async function putMemory(input: {
  userId: string;
  kind: MemoryKind;
  content: string;
  sourceThreadId?: string | null;
}): Promise<MemoryRecord> {
  const userId = input.userId.trim();
  const content = input.content.trim();

  if (!userId) {
    throw new Error("putMemory: userId is required");
  }
  if (!content) {
    throw new Error("putMemory: content is required");
  }
  assertValidKind(input.kind);

  // 算向量(失败降级成"无向量记忆",不让整条写入失败)。
  const { embedding, embeddingModel } = await computeEmbedding(content);

  const row = await prisma.memory.create({
    data: {
      userId,
      kind: input.kind,
      content,
      sourceThreadId: input.sourceThreadId?.trim() || null,
      embedding,
      embeddingModel,
    },
  });

  return toMemoryRecord(row);
}

/**
 * 更新一条已有记忆的正文(Phase 12 #4 去重用)。
 *
 * memoryWriter 提炼出新记忆时,如果发现库里已有"几乎一样"的一条(相似度超阈值),
 * 不再插一条重复的,而是调这个函数把那条**刷新**成最新措辞 + 重算向量。
 * 这是最朴素的"合并"——用新表述覆盖旧表述,避免同一事实存很多遍。
 *
 * 找不到这个 id 返回 null(幂等,调用方自行决定要不要回退成插入)。
 */
export async function updateMemory(
  memoryId: string,
  content: string
): Promise<MemoryRecord | null> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("updateMemory: content is required");
  }

  const { embedding, embeddingModel } = await computeEmbedding(trimmed);

  try {
    const row = await prisma.memory.update({
      where: { id: memoryId },
      data: { content: trimmed, embedding, embeddingModel },
    });
    return toMemoryRecord(row);
  } catch {
    // Prisma 在记录不存在时抛 P2025 —— 当成"没更新到"处理
    return null;
  }
}

// ─── 语义检索 ─────────────────────────────────────────────────────

/**
 * 按语义检索某个用户的记忆。
 *
 * 步骤:
 *   1. 把查询 query 也算成向量
 *   2. 捞出该用户(可按 kind 过滤)、且 embeddingModel 和"当前模型"一致的记忆
 *   3. 逐条算 cosine similarity
 *   4. 过滤掉低于 minScore 的,按分数降序,取前 topK
 *
 * # 为什么只比 embeddingModel 一致的记忆
 *   不同 embedding 模型产出的向量在**不同的语义空间**里,维度、尺度都不同,
 *   跨模型算相似度得到的分数是错的。所以换了模型(指纹变了)以后,
 *   旧向量在检索时被自动跳过,避免污染结果。这和 ragCache 指纹失效同理。
 *
 * minScore 默认 0:这一层只负责"按相关度排序",不替调用方决定阈值。
 * 真正的"低于多少分就不要"留给 Phase 12 #3 recall 节点按 env 配置裁决。
 */
export async function searchMemories(input: {
  userId: string;
  query: string;
  kind?: MemoryKind;
  topK?: number;
  minScore?: number;
}): Promise<MemorySearchHit[]> {
  const userId = input.userId.trim();
  const query = input.query.trim();
  const topK = input.topK ?? 5;
  const minScore = input.minScore ?? 0;

  if (!userId || !query) {
    return [];
  }
  if (input.kind) {
    assertValidKind(input.kind);
  }

  const currentModel = getEmbeddingsIdentity();

  // 只捞"有向量、且和当前模型同指纹"的候选——其余的向量比不了,直接不参与。
  const rows = await prisma.memory.findMany({
    where: {
      userId,
      ...(input.kind ? { kind: input.kind } : {}),
      embeddingModel: currentModel,
      NOT: { embedding: null },
    },
  });

  if (rows.length === 0) {
    return [];
  }

  const queryVector = await createLangChainEmbeddings().embedQuery(query);

  const scored: MemorySearchHit[] = [];
  for (const row of rows) {
    if (!row.embedding) {
      continue;
    }
    const score = cosineSimilarity(queryVector, deserializeVector(row.embedding));
    if (score >= minScore) {
      scored.push({ ...toMemoryRecord(row), score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ─── 列出 / 删除 ──────────────────────────────────────────────────

/**
 * 列出某个用户的记忆(不做向量检索,纯按时间倒序)。
 * 给"AI 记忆管理"UI(Phase 12 #5)和调试用。
 */
export async function listMemories(input: {
  userId: string;
  kind?: MemoryKind;
  limit?: number;
}): Promise<MemoryRecord[]> {
  const userId = input.userId.trim();
  if (!userId) {
    return [];
  }
  if (input.kind) {
    assertValidKind(input.kind);
  }

  const rows = await prisma.memory.findMany({
    where: {
      userId,
      ...(input.kind ? { kind: input.kind } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: input.limit ?? 100,
  });

  return rows.map(toMemoryRecord);
}

/**
 * 删一条记忆。返回是否真的删到了(id 不存在返回 false,幂等)。
 * 不校验归属——只给调试脚本用。HTTP 接口请用 deleteMemoryForUser。
 */
export async function deleteMemory(memoryId: string): Promise<boolean> {
  const result = await prisma.memory.deleteMany({ where: { id: memoryId } });
  return result.count > 0;
}

/**
 * 删一条记忆,**但必须属于这个用户**(Phase 12 #5,给 HTTP 删除接口用)。
 *
 * where 同时带 id 和 userId:即使别人猜到了某条记忆的 id,也删不掉不属于自己的。
 * 这是多租户隔离的最后一道闸 —— 任何按 id 操作都要带 userId 兜底。
 * 删到返回 true,没删到(id 不存在 / 不属于该用户)返回 false。
 */
export async function deleteMemoryForUser(
  memoryId: string,
  userId: string
): Promise<boolean> {
  const result = await prisma.memory.deleteMany({
    where: { id: memoryId, userId },
  });
  return result.count > 0;
}

/**
 * 清空某个用户的全部记忆(Phase 12 #5,给"一键清空"用)。返回删除条数。
 */
export async function clearUserMemories(userId: string): Promise<number> {
  const result = await prisma.memory.deleteMany({ where: { userId } });
  return result.count;
}

// ─── 内部工具 ─────────────────────────────────────────────────────

/** 校验 kind 合法,非法直接抛错(取值约束在应用层,见 schema.prisma 注释)。 */
function assertValidKind(kind: string): asserts kind is MemoryKind {
  if (!MEMORY_KINDS.includes(kind as MemoryKind)) {
    throw new Error(
      `Invalid memory kind: "${kind}". Expected one of: ${MEMORY_KINDS.join(", ")}`
    );
  }
}

/** Prisma row → 对外 MemoryRecord(收掉 embedding 二进制,kind 收窄类型)。 */
function toMemoryRecord(row: {
  id: string;
  userId: string;
  kind: string;
  content: string;
  sourceThreadId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MemoryRecord {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind as MemoryKind,
    content: row.content,
    sourceThreadId: row.sourceThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 把一段文本算成 embedding 并序列化好,连同模型指纹一起返回。
 * 失败降级成 { null, null }:记忆仍能落库,只是这条暂时不能被向量检索到。
 *
 * 类型收窄到 Uint8Array<ArrayBuffer>:Prisma 6 的 Bytes 输入类型不接受
 * 宽泛的 ArrayBufferLike(它可能是 SharedArrayBuffer)。
 */
async function computeEmbedding(text: string): Promise<{
  embedding: Uint8Array<ArrayBuffer> | null;
  embeddingModel: string | null;
}> {
  try {
    const vector = await createLangChainEmbeddings().embedQuery(text);
    return {
      embedding: serializeVector(vector),
      embeddingModel: getEmbeddingsIdentity(),
    };
  } catch (error) {
    console.error(
      "[MemoryStore] embedding failed, storing memory without vector:",
      error
    );
    return { embedding: null, embeddingModel: null };
  }
}

/**
 * 向量 → BLOB。用 Float32(而不是 Float64)省一半空间,
 * embedding 相似度对 float32 精度完全够用。
 *
 * 用 DataView 显式写 little-endian,不依赖运行平台字节序,跨机器读出来一致。
 */
function serializeVector(vector: number[]): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < vector.length; i += 1) {
    view.setFloat32(i * 4, vector[i], true);
  }
  return new Uint8Array(buffer);
}

/**
 * BLOB → 向量。
 *
 * 注意:Prisma 6 把 Bytes 读出来是 Uint8Array(不是 Buffer),且可能是某个
 * 大 ArrayBuffer 上的"视图"(byteOffset 不为 0)。所以用 DataView 带上
 * byteOffset / byteLength 精确定位,再逐个 getFloat32,稳妥不踩对齐坑。
 */
function deserializeVector(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = Math.floor(bytes.byteLength / 4);
  const vector = new Array<number>(length);
  for (let i = 0; i < length; i += 1) {
    vector[i] = view.getFloat32(i * 4, true);
  }
  return vector;
}

/**
 * 余弦相似度 = 点积 /(两个向量的模长之积)。范围 -1..1,语义越近越接近 1。
 *
 * 这里不假设向量已归一化(Ollama 的 nomic-embed-text 输出未必是单位向量),
 * 所以老老实实除以模长。维度不一致或零向量时返回 0(判为不相关)。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
