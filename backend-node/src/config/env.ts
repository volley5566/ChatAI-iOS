import dotenv from "dotenv";

/**
 * 配置和 DeepSeek 客户端
 * 统一读取环境变量。
 * 这里是统一读取 .env
 * 让 server.ts 不再关心 .env 细节，只拿已经校验过的配置使用。
 */
/**
 * quiet: true 很重要。
 *
 * dotenv v17 默认会输出一行“injected env”的提示。
 * 普通 HTTP server 里这只是噪音，但 MCP stdio server 的 stdout 必须只写
 * JSON-RPC 协议消息；如果 dotenv 日志混进 stdout，会破坏 MCP 通信。
 */
dotenv.config({ quiet: true });

export const port = Number(process.env.PORT || 8000);
export const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
export const deepseekBaseURL =
  process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
export const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
export const embeddingsProvider =
  process.env.EMBEDDINGS_PROVIDER || "local-keyword";

/**
 * LangChain RAG 配置。
 *
 * 这些值不写死在 retriever 里，是为了方便你边学习边调参：
 * - RAG_TOP_K：每次检索最多取多少个 chunk
 * - RAG_CHUNK_SIZE：每个 chunk 目标字符数
 * - RAG_CHUNK_OVERLAP：相邻 chunk 重叠字符数
 * - RAG_MIN_SIMILARITY：低于这个相似度的结果不交给模型
 */
export const ragTopK = readIntegerEnv("RAG_TOP_K", 5, 1);
export const ragChunkSize = readIntegerEnv("RAG_CHUNK_SIZE", 1200, 200);
export const ragChunkOverlap = readIntegerEnv("RAG_CHUNK_OVERLAP", 160, 0);
export const ragMinSimilarity = readNumberEnv("RAG_MIN_SIMILARITY", 0.08, 0);

export function requireDeepSeekApiKey(): string {
  /**
   * 不在模块加载时直接 throw，是为了让纯 RAG debug 脚本也能运行。
   * 真正调用 DeepSeek 的地方会通过这个函数取 key；
   * 如果 .env 没配，再给出明确错误。
   */
  if (!deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is missing. Please add it to your .env file.");
  }

  return deepseekApiKey;
}

function readIntegerEnv(
  name: string,
  defaultValue: number,
  minValue: number
): number {
  const value = readNumberEnv(name, defaultValue, minValue);
  return Math.round(value);
}

function readNumberEnv(
  name: string,
  defaultValue: number,
  minValue: number
): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return defaultValue;
  }

  const parsedValue = Number(rawValue);

  if (!Number.isFinite(parsedValue)) {
    return defaultValue;
  }

  return Math.max(parsedValue, minValue);
}
