import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/ragCache.ts — 向量缓存(磁盘 JSON 文件)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   ragRetriever.ts 启动时先查缓存,命中就跳过 embedding;没命中重建后写回。
 *
 * # 解决的痛点
 *   每次后端启动都要跑:Document → split → embedding × N → 内存向量库。
 *   N = chunk 数量,5-6 个 markdown 文档大约 30-50 个 chunk。
 *   单次 Ollama embedding 30-80ms,启动要等 2-5 秒——
 *   dev 改一行代码 ts-node-dev 自动重启就重新等一次,很烦。
 *
 * # 缓存策略
 *   - 序列化(向量, 文档内容, metadata)到 JSON
 *   - 启动时先比 fingerprint:
 *       匹配 → 直接读 JSON,跳过 embedding
 *       不匹配 → 重建 + 覆盖写新 JSON
 *
 * # fingerprint 输入
 *   - embedding 模型标识(切换模型必须重建)
 *   - chunk 切分参数(改了切分必须重建)
 *   - 所有源文档的 fileName + content hash(改文档必须重建)
 *
 * 这套"用 hash 作为缓存有效性判据"的思路在生产里也通用,
 * webpack / vite / npm install 全是这么做的。
 */

export type CacheEntry = {
  /** 这个 chunk 的 embedding 向量。768 维(nomic) / 512 维(local-keyword)等。 */
  vector: number[];
  /** chunk 的文本内容,会原样喂回 LLM。 */
  pageContent: string;
  /** chunk 的 metadata(fileName, title, section, citation, chunkId, ...)。 */
  metadata: Record<string, unknown>;
};

export type CacheFile = {
  /** 完整指纹。读取时第一件事就是和当前指纹比对。 */
  fingerprint: string;
  /** 写入时间。纯调试用,看缓存多旧了。 */
  createdAt: string;
  /** 当时用的 embedding 模型标识。debug 时一眼能看出"哦这是 ollama:nomic 的缓存"。 */
  embeddingIdentity: string;
  /** 向量维度。读出来时可以做一次合法性 check。 */
  dimensions: number;
  /** chunk 数量。也是写日志/调试用。 */
  entryCount: number;
  /** chunk 切分参数,记下来便于排查"为啥切得不一样"。 */
  chunkSize: number;
  chunkOverlap: number;
  /** 真正的数据。 */
  entries: CacheEntry[];
};

export type FingerprintInputs = {
  embeddingIdentity: string;
  chunkSize: number;
  chunkOverlap: number;
  documents: Array<{ fileName: string; content: string }>;
};

/**
 * 计算缓存指纹。
 *
 * 用 sha256 把所有"影响向量结果"的输入混合在一起。
 * 任何一个字节变了,输出 hash 就变,缓存自动失效。
 *
 * 为什么按 fileName 排序? 因为 documentLoader 不保证文件返回顺序,
 * 排序后 fingerprint 就和文件系统遍历顺序无关,跨机器/跨 OS 一致。
 */
export function computeFingerprint(inputs: FingerprintInputs): string {
  const hash = crypto.createHash("sha256");

  hash.update(`embedding:${inputs.embeddingIdentity}`);
  hash.update(`|chunk:${inputs.chunkSize}/${inputs.chunkOverlap}`);

  const sortedDocs = [...inputs.documents].sort((a, b) =>
    a.fileName.localeCompare(b.fileName)
  );

  for (const doc of sortedDocs) {
    hash.update(`|file:${doc.fileName}|`);
    hash.update(doc.content);
  }

  return hash.digest("hex");
}

/**
 * 尝试从磁盘加载缓存。
 *
 * 返回 null 的所有情况:
 *   - 文件不存在(第一次启动)
 *   - JSON 解析失败(被人手动改坏了)
 *   - fingerprint 不匹配(知识库/模型/切分参数变了)
 *
 * 返回 null 后调用方应该走"完整 embedding + 重新写缓存"的路径。
 */
export async function loadCache(
  cachePath: string,
  expectedFingerprint: string
): Promise<CacheEntry[] | null> {
  let raw: string;

  try {
    raw = await fs.readFile(cachePath, "utf-8");
  } catch {
    // 文件不存在是常态(第一次启动),不打 error。
    return null;
  }

  let parsed: CacheFile;

  try {
    parsed = JSON.parse(raw) as CacheFile;
  } catch (error) {
    /**
     * 文件存在但坏了——可能是上次写到一半进程被杀。
     * 这里不抛错,直接当 miss 处理:下面的逻辑会重建并覆盖写。
     */
    console.error(
      `[RAG cache] ${cachePath} parse failed, will rebuild:`,
      error
    );
    return null;
  }

  if (parsed.fingerprint !== expectedFingerprint) {
    /**
     * 指纹不匹配——知识库或模型变了。
     * 留个日志方便调试"为啥缓存又失效了"。
     */
    console.error(
      `[RAG cache] fingerprint mismatch (cache: ${parsed.fingerprint.slice(0, 8)}..., ` +
        `expected: ${expectedFingerprint.slice(0, 8)}...), will rebuild.`
    );
    return null;
  }

  return parsed.entries;
}

/**
 * 写缓存。
 *
 * 用 atomic rename 避免"写到一半进程被杀,留个半文件"的问题:
 *   1. 先写到 .tmp 文件
 *   2. rename 覆盖目标
 * rename 在大多数 POSIX 系统上是原子操作。
 */
export async function saveCache(
  cachePath: string,
  file: CacheFile
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const tmpPath = `${cachePath}.tmp`;

  /**
   * JSON.stringify 不带 indent 参数。
   * 30-50 个 chunk × 768 维向量 ≈ 几百 KB,带缩进会膨胀 2-3 倍。
   * 这文件人不需要直接看,机器读就够了。
   */
  await fs.writeFile(tmpPath, JSON.stringify(file), "utf-8");
  await fs.rename(tmpPath, cachePath);
}
