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

/**
 * 第三阶段：LangChain Agent / 工具 / 流式相关配置。
 *
 * 全部走环境变量，方便边运行边调，不用改代码：
 *
 * - AGENT_RECURSION_LIMIT：Agent 内部最多迭代多少步。
 *   单次 Agent 会经历多个阶段（model -> tools -> model -> ...），
 *   这个值是“无论模型怎么决策，总迭代步数的上限”。
 *
 * - AGENT_MODEL_RETRY_MAX_ATTEMPTS：模型调用失败后由 modelRetryMiddleware
 *   触发的重试次数。和下面的 HTTP 层 maxRetries 不同：
 *     HTTP 层重试：单次 fetch 失败 / 429 / 5xx，由 @langchain/openai 处理
 *     Middleware 重试：包住整个 model node，可以加退避、可以选择失败时继续
 *
 * - AGENT_MODEL_CALL_LIMIT：整次 Agent 最多调用模型多少次。
 *   这个是“成本兜底”——防止模型陷入 tool-call 循环把账单打爆。
 *
 * - CHAT_MODEL_HTTP_MAX_RETRIES：传给 ChatDeepSeek 的 maxRetries。
 *   HTTP 失败时由 LangChain/OpenAI SDK 在 fetch 层做指数退避。
 *
 * - TOOL_EXECUTION_TIMEOUT_MS：单个工具最长执行时间。
 *   工具卡死时不会拖垮整次请求。
 */
/**
 * 默认 20 不是拍脑袋写的。
 *
 * LangChain Agent 内部把每一个推理阶段（model / tools / 中间转发）都算一次步数。
 * 一次正常对话大致是：
 *   start → agent(model) → tools → agent(model) → end
 * 看起来只有 4~6 步，按理 8 就够。
 *
 * 但第三阶段挂了 5 个 middleware（retry / callLimit / 三个 toolCallLimit），
 * 每个 middleware 都会包住 model / tool 阶段，实际步数会显著放大。
 * 实测带这套 middleware 时单轮工具调用大约要消耗 12~15 步，
 * 留点余量定 20。
 *
 * 真正“失控的循环”一般是模型反复调用同一个工具，
 * 这种已经由 toolCallLimitMiddleware 拦下了，recursionLimit 是最后兜底。
 */
export const agentRecursionLimit = readIntegerEnv("AGENT_RECURSION_LIMIT", 20, 4);
export const agentModelRetryMaxAttempts = readIntegerEnv(
  "AGENT_MODEL_RETRY_MAX_ATTEMPTS",
  2,
  0
);
export const agentModelCallLimit = readIntegerEnv(
  "AGENT_MODEL_CALL_LIMIT",
  6,
  1
);
export const chatModelHttpMaxRetries = readIntegerEnv(
  "CHAT_MODEL_HTTP_MAX_RETRIES",
  2,
  0
);
export const toolExecutionTimeoutMs = readIntegerEnv(
  "TOOL_EXECUTION_TIMEOUT_MS",
  8000,
  1000
);

/**
 * LangSmith 接入。
 *
 * 不需要写任何 SDK 代码——LangChain 启动时如果检测到这两个环境变量，
 * 会自动把所有 Chain / Model / Tool / Agent 调用上报到 smith.langchain.com：
 *   LANGSMITH_TRACING=true
 *   LANGSMITH_API_KEY=lsv2_pt_...
 *   LANGSMITH_PROJECT=ai-ios-chat-demo   (可选，默认 "default")
 *
 * 这里把开关读出来，主要是为了：
 * - 启动时在 console 提示当前是否在 trace
 * - 后续如果要做“按请求维度的 tag/metadata”，可以在 RunnableConfig 里使用
 *
 * 没配的情况下，LangChain 不会上报任何数据，也不会影响本地运行。
 */
const langSmithTracingRaw = (process.env.LANGSMITH_TRACING || "").trim().toLowerCase();
export const langSmithTracingEnabled =
  langSmithTracingRaw === "true" || langSmithTracingRaw === "1";
export const langSmithProject = process.env.LANGSMITH_PROJECT?.trim() || undefined;

export function logLangSmithStatus(): void {
  /**
   * 进程启动时调用一次。
   *
   * 这个日志不属于 Agent 链路（没有 requestId），所以走最普通的 console.log，
   * 不复用 logAgentInfo 的 JSON 信封。
   */
  if (langSmithTracingEnabled) {
    const projectSuffix = langSmithProject ? ` (project: ${langSmithProject})` : "";
    console.log(`[LangSmith] tracing enabled${projectSuffix}`);
    return;
  }

  console.log("[LangSmith] tracing disabled (set LANGSMITH_TRACING=true to enable)");
}

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
