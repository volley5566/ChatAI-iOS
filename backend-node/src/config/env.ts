/**
 * ═══════════════════════════════════════════════════════════════════
 * config/env.ts — 所有环境变量在这里集中读取、校验、暴露
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   .env 文件 → dotenv → 这个文件 → 全项目按需 import 命名常量
 *
 * 设计原则:
 *   - server.ts 和业务模块**不直接读** process.env,统一从这里 import
 *   - 数值类型的环境变量在这里就解析并做最小值校验
 *   - 默认值都写在这里,改默认值只改一处
 */

import dotenv from "dotenv";

// quiet: true 很重要。
// dotenv v17 默认会输出"injected env"提示。
// HTTP server 里这只是噪音,但 MCP stdio server 的 stdout 必须只写
// JSON-RPC 协议消息——如果 dotenv 日志混进 stdout,会破坏 MCP 通信。
dotenv.config({ quiet: true });

// ─── 服务器 & DeepSeek 基础配置 ───────────────────────────────

export const port = Number(process.env.PORT || 8000);
export const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
export const deepseekBaseURL =
  process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
export const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

// ─── Embedding 配置 ──────────────────────────────────────────

/**
 * Embedding 提供方切换。
 *
 * 支持的值:
 *   - "local-keyword" / "local" → 老的 hash 伪向量(早期阶段的兜底),不需要外部依赖
 *   - "ollama"                  → 走本地 Ollama 服务跑真正的语义 embedding(默认)
 *
 * 工厂函数 embeddings.ts 根据这个值选择具体实现,
 * 上层 retriever / agent / iOS 完全感知不到底层切换。
 *
 * 默认 "ollama":没装 Ollama 的人会立刻看到明确报错,
 * 而不是"为什么 RAG 这么蠢"——比悄悄降级好得多。
 */
export const embeddingsProvider = process.env.EMBEDDINGS_PROVIDER || "ollama";

/**
 * Ollama 本地服务地址,默认 127.0.0.1:11434。
 * 做成 env 配置是为了:
 *   - 将来想把 Ollama 跑在另一台机器(远程 GPU)只改 .env
 *   - 测试环境可以指向不同端口
 */
export const ollamaBaseUrl =
  process.env.OLLAMA_BASE_URL || "http://localhost:11434";

/**
 * Ollama 用于 embedding 的模型名。
 *
 * 默认 "nomic-embed-text":
 *   - 768 维真实语义向量
 *   - 中英文都支持(知识库里中英文混排)
 *   - 274 MB 模型大小,M 系列 Mac 跑起来很轻
 *
 * 想试其他模型:
 *   ollama pull mxbai-embed-large    (1024 维,质量更高,体积也大)
 *   ollama pull bge-m3               (1024 维,多语言更强,体积更大)
 * 然后在 .env 改 OLLAMA_EMBEDDING_MODEL 即可。
 */
export const ollamaEmbeddingModel =
  process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";

// ─── RAG 检索参数 ────────────────────────────────────────────

/**
 * 这些值不写死在 retriever 里,方便边学习边调参:
 *   RAG_TOP_K           → 每次检索最多取多少个 chunk
 *   RAG_CHUNK_SIZE      → 每个 chunk 目标字符数
 *   RAG_CHUNK_OVERLAP   → 相邻 chunk 重叠字符数
 *   RAG_MIN_SIMILARITY  → 低于这个相似度的结果不交给模型
 */
export const ragTopK = readIntegerEnv("RAG_TOP_K", 5, 1);
export const ragChunkSize = readIntegerEnv("RAG_CHUNK_SIZE", 1200, 200);
export const ragChunkOverlap = readIntegerEnv("RAG_CHUNK_OVERLAP", 160, 0);
export const ragMinSimilarity = readNumberEnv("RAG_MIN_SIMILARITY", 0.08, 0);

// ─── Agent / 工具 / 流式相关 ────────────────────────────────

/**
 * Agent 内部最多迭代多少步。
 *
 * 单次 Agent 会经历多个阶段(model → tools → model → ...),
 * 这个值是"无论模型怎么决策,总迭代步数的上限"。
 *
 * 默认 20 不是拍脑袋写的:
 *   理论上一次正常对话只有 4~6 步,
 *   但挂了 5 个 middleware(retry / callLimit / 3 个 toolCallLimit)后,
 *   每个 middleware 都会包住 model/tool 阶段,实际步数会显著放大,
 *   实测单轮工具调用大约消耗 12~15 步,留点余量定 20。
 *
 * 真正"失控的循环"由 toolCallLimitMiddleware 拦下,recursionLimit 是最后兜底。
 */
export const agentRecursionLimit = readIntegerEnv("AGENT_RECURSION_LIMIT", 20, 4);

/**
 * 模型调用失败后由 modelRetryMiddleware 触发的重试次数。
 *
 * 和 ChatDeepSeek 的 maxRetries 是两层重试:
 *   HTTP 层 (maxRetries)  → 单次 fetch 失败 / 429 / 5xx,由 SDK 处理
 *   Middleware 层         → 包住整个 model node,可以加退避、可以选择失败时继续
 */
export const agentModelRetryMaxAttempts = readIntegerEnv(
  "AGENT_MODEL_RETRY_MAX_ATTEMPTS",
  2,
  0
);

/**
 * 整次 Agent 最多调用模型多少次。
 * 成本兜底:防止模型陷入 tool-call 循环把账单打爆。
 */
export const agentModelCallLimit = readIntegerEnv("AGENT_MODEL_CALL_LIMIT", 6, 1);

/** 传给 ChatDeepSeek 的 maxRetries:HTTP 失败时 SDK 在 fetch 层做指数退避。 */
export const chatModelHttpMaxRetries = readIntegerEnv(
  "CHAT_MODEL_HTTP_MAX_RETRIES",
  2,
  0
);

/**
 * 单个工具最长执行时间(毫秒)。
 *
 * 早期阶段 8 秒足够(所有工具都是本地纯计算:向量检索 / 模板拼接)。
 * 引入 "LLM-as-tool" 后,evaluateAnswer / recommendNextTopic / generateQuiz
 * 都会在工具内部再发一次 DeepSeek 请求,单次 API 延迟在 2-10 秒波动。
 *
 * 现在默认 20 秒——既容忍 DeepSeek 偶尔慢响应,又不会让卡死的工具拖死整个请求。
 */
export const toolExecutionTimeoutMs = readIntegerEnv(
  "TOOL_EXECUTION_TIMEOUT_MS",
  20000,
  1000
);

// ─── LangGraph 切换开关 ──────────────────────────────────────

/**
 * Agent Runner 用 createAgent 还是手写 StateGraph,做成 env 灰度开关:
 *
 *   USE_LANGGRAPH=true(默认)  → 走 runLangGraphAgentStream
 *     享受 checkpointer 持久化、thread_id 跨请求记忆等能力
 *
 *   USE_LANGGRAPH=false        → 走 runLangChainAgentStream
 *     行为等价于 createAgent,主要给"想对比 createAgent 写法"的学习场景保留
 *     注意:这条路径**不支持 checkpointer**,thread_id 会被忽略,持久化失效
 *
 * 这是大型重构常用的 "feature flag" 模式——新旧实现并行存活,
 * 通过开关切流量,有问题秒回滚。
 *
 * 默认 true 的原因:LangGraph + checkpointer 是主推荐路径,
 * 默认 false 会让新人发现"咦怎么 AI 不记事",排查半天才发现是 flag 没开。
 */
const useLangGraphRaw = (process.env.USE_LANGGRAPH || "").trim().toLowerCase();
export const useLangGraph = useLangGraphRaw !== "false" && useLangGraphRaw !== "0";

// ─── LangSmith 接入 ─────────────────────────────────────────

/**
 * 不需要写任何 SDK 代码——LangChain 启动时检测到这几个 env 就会自动把所有
 * Chain / Model / Tool / Agent 调用上报到 smith.langchain.com:
 *   LANGSMITH_TRACING=true
 *   LANGSMITH_API_KEY=lsv2_pt_...
 *   LANGSMITH_PROJECT=ai-ios-chat-demo   (可选,默认 "default")
 *
 * 这里把开关读出来,主要是:
 *   - 启动时在 console 提示当前是否在 trace
 *   - 后续如果要做"按请求维度的 tag/metadata",可以在 RunnableConfig 里用
 *
 * 没配的情况下不上报、不影响本地运行。
 */
const langSmithTracingRaw = (process.env.LANGSMITH_TRACING || "").trim().toLowerCase();
export const langSmithTracingEnabled =
  langSmithTracingRaw === "true" || langSmithTracingRaw === "1";
export const langSmithProject = process.env.LANGSMITH_PROJECT?.trim() || undefined;

/**
 * 进程启动时打印一次 LangSmith 状态。
 *
 * 这个日志不属于 Agent 链路(没有 requestId),所以走最普通的 console.log,
 * 不复用 logAgentInfo 的 JSON 信封。
 */
export function logLangSmithStatus(): void {
  if (langSmithTracingEnabled) {
    const projectSuffix = langSmithProject ? ` (project: ${langSmithProject})` : "";
    console.log(`[LangSmith] tracing enabled${projectSuffix}`);
    return;
  }
  console.log("[LangSmith] tracing disabled (set LANGSMITH_TRACING=true to enable)");
}

// ─── 工具函数 ───────────────────────────────────────────────

/**
 * 取 DeepSeek API key 的"惰性"入口。
 *
 * 不在模块加载时直接 throw,是为了让纯 RAG debug 脚本也能运行
 * (它们不调用 DeepSeek,不需要 key)。真正调用的地方再触发这个检查。
 */
export function requireDeepSeekApiKey(): string {
  if (!deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is missing. Please add it to your .env file.");
  }
  return deepseekApiKey;
}

/** 读 env 整数,带默认值和最小值兜底 */
function readIntegerEnv(name: string, defaultValue: number, minValue: number): number {
  const value = readNumberEnv(name, defaultValue, minValue);
  return Math.round(value);
}

/** 读 env 浮点数,带默认值和最小值兜底 */
function readNumberEnv(name: string, defaultValue: number, minValue: number): number {
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
