import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { runLangChainAgentStream } from "./agent/agentRunner";
import {
  createAgentRequestId,
  getDurationMs,
  logAgentError,
  logAgentInfo,
} from "./agent/agentObservability";
import { logChatContext, prepareChatCompletion } from "./chat/chatCompletion";
import { sanitizeChatHistory } from "./chat/chatHistory";
import { logLangSmithStatus, model, port } from "./config/env";
import { writeSseEvent } from "./http/sse";
import { parseStructuredAnswer } from "./chat/structuredAnswer";
import {
  invokeLangChainChat,
  streamLangChainChat,
} from "./langchain/chatModel";
import type {
  ChatRequestBody,
  ChatResponseBody,
  ChatStreamEvent,
  ErrorResponseBody,
  FeedbackRequestBody,
  FeedbackResponseBody,
} from "./shared/types";
import {
  createThread,
  deleteThread,
  getThreadMessages,
  listThreads,
  touchThread,
} from "./db/threadsRepository";
import {
  LangSmithFeedbackDisabledError,
  submitUserFeedback,
} from "./langchain/langsmithClient";

/**
 * server.ts 现在只负责 Express 路由和 HTTP 生命周期。
 *
 * 具体业务已经拆到独立模块：
 * - config/env.ts：环境变量
 * - langchain/*：LangChain RAG、ChatDeepSeek、Tool、Agent
 * - chat/*：普通聊天上下文、history 清洗、prompt、结构化解析
 * - knowledge/knowledge.ts：RAG 知识库
 * - agent/*：Agent SSE 事件和观测辅助
 * - mcp/*：MCP client/server 与真实工具实现
 * - http/sse.ts：SSE 输出
 * - shared/types.ts：共享类型
 */
// 创建后端服务。
const app = express();

/**
 * Phase 10.4 #12 — Helmet 安全头。
 *
 * 一行代码给每个 HTTP 响应自动加一堆安全相关的 header:
 *   X-Content-Type-Options: nosniff     ← 防止浏览器猜测 MIME 类型(XSS 防护)
 *   X-Frame-Options: SAMEORIGIN         ← 防止页面被嵌入 iframe(点击劫持防护)
 *   X-XSS-Protection: 0                 ← 关掉老浏览器的 XSS 过滤(现代浏览器有 CSP)
 *   Strict-Transport-Security           ← 强制 HTTPS
 *   ...还有十几个
 *
 * 不影响 API 行为,纯安全加固。没有它,安全扫描工具会报一堆"缺少安全头"的 warning。
 *
 * Android 类比: 就像 AndroidManifest 里的 android:usesCleartextTraffic="false",
 * 一个配置项提升整体安全基线。
 */
app.use(helmet());

// 允许 iOS / 浏览器跨域访问。
app.use(cors());

/**
 * Phase 10.4 #12 — Rate Limiting(限流)。
 *
 * 防止有人疯狂调接口(恶意攻击 / 爬虫 / 写了个死循环的客户端):
 *   - 同一个 IP,15 分钟内最多 100 次请求
 *   - 超了就返回 429 "Too Many Requests"
 *
 * 为什么限流很重要:
 *   每次 /api/agent/stream 调用都会消耗 DeepSeek API token(花钱),
 *   没有限流的话,一个恶意脚本就能把你的 API 余额烧光。
 *
 * 为什么是 100 次 / 15 分钟:
 *   正常用户 15 分钟内不太可能发超过 100 条消息。
 *   这个值偏宽松——生产环境可以按实际用量收紧。
 *
 * standardHeaders: true → 在响应头里带 RateLimit-* 标准字段,
 *   iOS 端可以读这些头来提前显示"请稍后再试"。
 *
 * Android 类比: 就像 OkHttp Interceptor 里检查请求频率,
 * 超限就直接返回 429 不往下游发。
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 分钟
  limit: 100,                 // 每个 IP 最多 100 次
  standardHeaders: true,      // 返回标准 RateLimit-* 头
  legacyHeaders: false,       // 不返回老式 X-RateLimit-* 头
  message: { error: "Too many requests, please try again later." },
});

// 只给 /api 路径加限流(健康检查 /health 不限)
app.use("/api", apiLimiter);

// express.json() 让后端能读取 JSON 请求体。
// limit: "1mb" 是限制请求体大小，避免用户传超大内容。
app.use(express.json({ limit: "1mb" }));

/**
 * 它暴露了 4 个接口：
 * - GET /health：健康检查
 * - /api/chat：非流式结构化 JSON
 * - /api/chat/stream：普通流式回答，固定 RAG
 * - /api/agent/stream：现在最核心的链路，Agent + Tool Calling + MCP + SSE
 */
// 9. 健康检查接口
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "ai-ios-chat-backend",
  });
});

// 10. 聊天接口：非流式结构化 JSON
app.post(
  "/api/chat",
  async (
    req: Request,
    res: Response<ChatResponseBody | ErrorResponseBody>
  ) => {
    try {
      const body = req.body as ChatRequestBody;
      const message = body.message?.trim();
      const systemPrompt = body.system_prompt?.trim();
      const history = sanitizeChatHistory(body.history);

      if (!message) {
        res.status(400).json({
          error: "Message cannot be empty.",
        });
        return;
      }

      const { knowledgeMatches, langChainMessages } = await prepareChatCompletion(
        message,
        systemPrompt,
        history,
        "structured"
      );

      logChatContext("structured", knowledgeMatches, history);

      /**
       * 普通结构化接口现在使用 LangChain ChatDeepSeek。
       *
       * 这一条链路是：
       *   LangChain Retriever -> ChatPromptTemplate -> ChatDeepSeek -> JSON parser
       *
       * Agent 接口在第二阶段也已经切到 LangChain createAgent，
       * 但它有独立的 SSE 事件格式，所以仍由 /api/agent/stream 单独处理。
       */
      const rawAnswer = await invokeLangChainChat(langChainMessages);
      const structuredAnswer = parseStructuredAnswer(rawAnswer);

      res.json(structuredAnswer);
    } catch (error) {
      console.error("Chat API error:", error);

      res.status(500).json({
        error: "Failed to generate AI response.",
      });
    }
  }
);

// 11. 普通流式聊天接口：固定 RAG + stream: true
app.post(
  "/api/chat/stream",
  async (
    req: Request,
    res: Response<ErrorResponseBody>
  ) => {
    let clientClosed = false;

    res.on("close", () => {
      clientClosed = true;
    });

    try {
      const body = req.body as ChatRequestBody;
      const message = body.message?.trim();
      const systemPrompt = body.system_prompt?.trim();
      const history = sanitizeChatHistory(body.history);

      if (!message) {
        res.status(400).json({
          error: "Message cannot be empty.",
        });
        return;
      }

      const { knowledgeMatches, langChainMessages } = await prepareChatCompletion(
        message,
        systemPrompt,
        history,
        "streaming"
      );

      logChatContext("streaming", knowledgeMatches, history);

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const stream = streamLangChainChat(langChainMessages);

      for await (const delta of stream) {
        if (clientClosed) {
          break;
        }

        if (delta) {
          writeSseEvent(res, {
            type: "delta",
            delta,
          });
        }
      }

      if (!clientClosed) {
        writeSseEvent(res, {
          type: "done",
        });
      }

      res.end();
    } catch (error) {
      console.error("Streaming Chat API error:", error);

      if (!res.headersSent) {
        res.status(500).json({
          error: "Failed to stream AI response.",
        });
        return;
      }

      if (!clientClosed) {
        writeSseEvent(res, {
          type: "error",
          error: "Failed to stream AI response.",
        });
      }

      res.end();
    }
  }
);

// Node.js 接住请求。
// Agent 流式接口：Tool Calling + MCP + 工具状态可视化 + 最终流式回答。
//- app.post(path, handler) 注册一条路由
app.post(
  "/api/agent/stream",
  async (
    req: Request,
    res: Response<ErrorResponseBody>
  ) => {
    /**
     * 这条 requestId 是本次 Agent 请求的“链路编号”。
     *
     * 后面会被写到三个地方：
     * 1. X-Request-ID response header：方便 HTTP 调试工具查看
     * 2. SSE event.request_id：方便 iOS 端必要时展示/上报
     * 3. 后端结构化日志：方便按 requestId grep 完整链路
     */
    const requestId = createAgentRequestId(); // ① 生成 trace id
    const requestStartedAt = Date.now();
    let clientClosed = false;
    let responseCompleted = false;
    /**
     * activePhase 用来标记“当前请求正在做什么”。
     *
     * 如果中途 throw，catch 里会用它记录错误发生在哪个阶段：
     * - request_validation
     * - langchain_agent
     */
    let activePhase = "request_validation";

    const writeAgentSseEvent = (event: ChatStreamEvent) => {
      /**
       * Agent 专用 SSE 写入函数。
       *
       * 普通聊天接口不需要 request_id；
       * Agent 接口链路更长，包含工具阶段，所以每条事件都补上 request_id，
       * 让客户端事件和服务端日志能对齐。
       */
      writeSseEvent(res, {
        ...event,
        request_id: requestId,
      });
    };

    res.setHeader("X-Request-ID", requestId);// ② 写响应头

    res.on("close", () => {// ③ 监听断连
      clientClosed = true;

      if (!responseCompleted) {
        /**
         * close 不一定是错误：用户可能退出页面、取消请求、网络断开。
         * 但对 Agent 调试很重要，因为它解释了为什么后端没有写 done。
         */
        logAgentInfo(requestId, "http", "client_closed", {
          durationMs: getDurationMs(requestStartedAt),
          activePhase,
        });
      }
    });

    try {
      // as ChatRequestBody 是 TypeScript 类型断言，告诉 TS：我认为这个对象符合这个类型。
      const body = req.body as ChatRequestBody;

      // ?. 是可选链，意思是：如果 body.message 存在，就执行 .trim()；不存在就返回 undefined。
      const message = body.message?.trim();
      const systemPrompt = body.system_prompt?.trim();

      // sanitizeChatHistory() 是清洗历史消息，防止客户端乱传 system / tool 角色。
      const history = sanitizeChatHistory(body.history);

      /**
       * Phase 5.3:接收 thread_id。
       *
       * 处理三件事:
       *   1. trim:防止前后空格被认成有效 id
       *   2. 空字符串视为没传:`""` 是无意义的 id,转成 undefined
       *   3. **不做强校验**(不要求是 UUID 格式)——
       *      让 iOS 端 / 测试脚本灵活塞任意字符串,
       *      只要客户端自己保证唯一性即可
       *
       * 如果将来要做"thread_id 必须是 UUID v4"这种校验,
       * 可以加 zod 或正则,但学习项目目前不需要。
       */
      const rawThreadId = body.thread_id?.trim();
      const threadId = rawThreadId || undefined;

      /**
       * Phase 5.4:有 threadId 就 touch 一下 Prisma threads 表。
       *
       * 这个调用做两件事:
       *   1. 如果 thread 不存在 → 自动创建一行(iOS 直接发消息也能用,不必先 POST /api/threads)
       *   2. 如果 thread 存在 → 刷新 updatedAt(对话列表能按"最近活跃"排序)
       *
       * 注意 await 一下——确保 Prisma 写完再启动 Agent。
       * touch 失败会让整个请求挂掉(我们故意不 try/catch),
       * 因为 db 都写不了,后续 checkpointer 也大概率出问题,早 fail 早暴露。
       */
      if (threadId) {
        await touchThread(threadId);
      }

      logAgentInfo(requestId, "request", "received", {
        /**
         * 这里不记录完整 message 内容，避免用户输入进入后端日志。
         * 只记录长度、history 数量和是否有 system prompt，足够排查上下文规模问题。
         *
         * threadId 是后端生成或客户端传的 trace id,不算用户内容,记进日志没问题。
         * 没传就显示 "(none)" 一眼能看出走的是无持久化模式。
         */
        route: "/api/agent/stream",
        model,
        messageLength: message?.length || 0,
        hasSystemPrompt: Boolean(systemPrompt),
        historyCount: history.length,
        threadId: threadId || "(none, no persistence)",
      });

      if (!message) {
        logAgentInfo(requestId, "request_validation", "rejected", {
          reason: "empty_message",
          durationMs: getDurationMs(requestStartedAt),
        });

        res.status(400).json({
          error: "Message cannot be empty.",
        });
        responseCompleted = true;
        return;
      }

      // 然后设置 SSE 响应头。
      // 这表示：后端不是一次性返回 JSON，而是保持连接，不断往 iOS 推送事件。
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();//flushHeaders() 立刻把响应头发出去,不等到有 body。这样 iOS 端能更快收到响应头,也能让 nginx 等代理别缓冲数据。

      /**
       * Node 进入 LangChain Agent 阶段。
       *
       * 第二阶段后，Agent 决策、工具调用循环、ToolMessage 组装都交给
       * LangChain createAgent。server.ts 只负责：
       * - 把工具状态转成 SSE
       * - 把最终 token 转成 delta
       * - 记录 request 级别日志
       */
      activePhase = "langchain_agent";
      const agentStartedAt = Date.now();
      let deltaCount = 0;
      let outputCharCount = 0;
      //调 Agent Runner(委派给 LangChain 层)
      const agentRun = await runLangChainAgentStream({
        requestId,
        message,
        systemPrompt,
        history,
        /**
         * Phase 5.3 新增 —— 把 threadId 透传给 runner。
         *
         * 路由层(agent/agentRunner.ts)会:
         * - 如果 USE_LANGGRAPH=true:把 threadId 给 Phase 4 → 启用 checkpointer
         * - 如果 USE_LANGGRAPH=false:Phase 3 路径会收下但忽略(故意不接持久化)
         */
        threadId,
        onToolEvent: (event) => {// 工具进度回调 - 工具事件发生 → 转成 SSE 发给 iOS
          if (!clientClosed) {
            writeAgentSseEvent({
              ...event,
              phase: "tool_execution",
            });
          }
        },
        onDelta: (delta) => {// token 流式回调 - 模型吐 token → 转成 SSE delta 发给 iOS
          if (clientClosed) {
            return;
          }

          deltaCount += 1;
          outputCharCount += delta.length;

          writeAgentSseEvent({
            type: "delta",
            delta,
            phase: "final_stream",
          });
        },
        shouldStop: () => clientClosed,// 提前终止信号- 我想提前停 → 返回 true
      });

      logAgentInfo(requestId, "langchain_agent", "server_observed_completed", {
        durationMs: getDurationMs(agentStartedAt),
        modelCalledTools: agentRun.toolCallCount > 0,
        toolCallCount: agentRun.toolCallCount,
        deltaCount,
        outputCharCount,
        /**
         * Phase 10.4 #13 — 在请求完成日志里记录 token 用量。
         * 方便用 grep 或日志平台做成本统计。
         */
        usage: agentRun.usage,
      });

      if (clientClosed) {
        logAgentInfo(requestId, "request", "stopped_after_client_close", {
          durationMs: getDurationMs(requestStartedAt),
          activePhase,
        });
        responseCompleted = true;
        res.end();
        return;
      }

      if (!clientClosed) {
        const totalDurationMs = getDurationMs(requestStartedAt);

        logAgentInfo(requestId, "final_stream", "completed", {
          /**
           * deltaCount / outputCharCount 用来粗略观察流式输出是否正常：
           * - deltaCount = 0 可能表示模型没输出内容
           * - outputCharCount 可以帮助判断回答是否异常短或异常长
           */
          durationMs: getDurationMs(agentStartedAt),
          deltaCount,
          outputCharCount,
        });

        logAgentInfo(requestId, "request", "completed", {
          durationMs: totalDurationMs,
          modelCalledTools: agentRun.toolCallCount > 0,
          toolCallCount: agentRun.toolCallCount,
          finalStreamDurationMs: getDurationMs(agentStartedAt),
          outputCharCount,
        });

        /**
         * 最后发送 done 事件,表示本次回答结束。
         *
         * Phase 10.1 #3 — 顺带把 LangSmith 根 run id 带回去。
         *
         * iOS 端拿到这个 id 后,会:
         *   - 把它存到对应 message 模型的 runId 字段
         *   - 用户点 👍/👎 时,POST /api/feedback { run_id, score }
         *
         * 这条字段做成可选,如果 runner 没拿到根 run id(理论上不会发生)
         * 就不发,前端的"反馈按钮"应该自然降级隐藏。
         */
        /**
         * Phase 10.4 #13 — done 事件带上 token 用量。
         *
         * agentRun.usage 来自 runner(无论 Phase 3 还是 Phase 4 路径),
         * 是所有 ReAct 循环中模型调用的 token 累加值。
         *
         * SSE 协议层字段名用 snake_case(prompt_tokens / completion_tokens / total_tokens),
         * 和 run_id / duration_ms 保持一致。
         *
         * iOS 拿到后可以在"消息详情"里展示 token 消耗,
         * 或者做客户端侧的每日/每月成本统计。
         */
        writeAgentSseEvent({
          type: "done",
          phase: "request_completed",
          duration_ms: totalDurationMs,
          run_id: agentRun.rootRunId,
          prompt_tokens: agentRun.usage.promptTokens,
          completion_tokens: agentRun.usage.completionTokens,
          total_tokens: agentRun.usage.totalTokens,
        });
      }

      responseCompleted = true;
      res.end();
    } catch (error) {
      const totalDurationMs = getDurationMs(requestStartedAt);

      logAgentError(requestId, activePhase, "failed", error, {
        durationMs: totalDurationMs,
      });

      if (!res.headersSent) {
        res.status(500).json({
          error: "Failed to run AI agent.",
        });
        responseCompleted = true;
        return;
      }

      if (!clientClosed) {
        /**
         * 如果错误发生在 SSE 已经建立之后，不能再返回 HTTP 500 JSON。
         * 只能通过 SSE error 事件告诉 iOS，并附上 request_id / phase / duration_ms。
         */
        writeAgentSseEvent({
          type: "error",
          error: "Failed to run AI agent.",
          phase: activePhase,
          duration_ms: totalDurationMs,
        });
      }

      responseCompleted = true;
      res.end();
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// Phase 5.4 — 对话管理接口(供 iOS 端管理 thread 列表用)
// ════════════════════════════════════════════════════════════════════
//
// 这 4 个接口都很简单——所有重活都在 threadsRepository 里做了,
// 路由层只负责"参数校验 + 包装 HTTP 响应"。
//
// 接口设计风格:
// - 都返回 JSON,不用 SSE(对话管理是离散操作,不是流式)
// - 错误统一返回 { error: string },HTTP 状态码遵守 REST 惯例
//   - 400 参数不合法
//   - 404 资源不存在
//   - 500 服务端错误

/**
 * POST /api/threads
 *
 * 创建新对话。
 * 请求体可带可选 title(没传就用 null,等以后由模型生成)。
 *
 * 返回新创建的 thread summary。iOS 端拿到 id 后,后续 /api/agent/stream
 * 就用这个 id 发消息。
 *
 * 但注意:iOS 也可以**直接发** /api/agent/stream 带新 id 跳过这个接口,
 * 因为 /api/agent/stream 内部会 touchThread 自动创建(见 5.3 的改动)。
 * 这个接口主要给"用户主动'新建对话'" 这种 UI 交互用。
 */
app.post("/api/threads", async (req: Request, res: Response) => {
  try {
    const body = req.body as { title?: string };
    const thread = await createThread({ title: body.title });
    res.status(201).json(thread);
  } catch (error) {
    console.error("[Threads] create failed:", error);
    res.status(500).json({ error: "Failed to create thread." });
  }
});

/**
 * GET /api/threads
 *
 * 列出所有对话,按最近活跃倒序。
 * iOS 端"对话列表页"启动时拉一次。
 *
 * 返回格式:{ threads: ThreadSummary[] }
 * 用对象包一层是为了将来加分页字段(total / next_cursor)时不破坏协议。
 */
app.get("/api/threads", async (_req: Request, res: Response) => {
  try {
    const threads = await listThreads();
    res.json({ threads });
  } catch (error) {
    console.error("[Threads] list failed:", error);
    res.status(500).json({ error: "Failed to list threads." });
  }
});

/**
 * GET /api/threads/:id/messages
 *
 * 拉某个对话的全部可展示消息。
 * iOS 端切换对话时拉一次,填充聊天界面。
 *
 * 返回 { messages: ThreadMessage[] }
 *   - 只包含 user / assistant 两类
 *   - 内部消息(tool_calls 中间消息、ToolMessage)已过滤
 */
app.get("/api/threads/:id/messages", async (req: Request, res: Response) => {
  /**
   * Express 的 req.params.id 类型是 `string | string[]`(防御性类型,
   * 因为 Express 理论上允许同名参数多个,虽然 ":id" 这种路径参数实际只会是 string)。
   * 用 typeof 守卫一下,把类型收窄到 string。
   */
  const rawId = req.params.id;
  const threadId = typeof rawId === "string" ? rawId.trim() : undefined;

  if (!threadId) {
    res.status(400).json({ error: "Thread id is required." });
    return;
  }

  try {
    const messages = await getThreadMessages(threadId);
    res.json({ messages });
  } catch (error) {
    console.error(`[Threads] get messages failed for ${threadId}:`, error);
    res.status(500).json({ error: "Failed to load thread messages." });
  }
});

/**
 * DELETE /api/threads/:id
 *
 * 删除对话——双向删:
 *   - Prisma threads 表删一行
 *   - LangGraph checkpoints / writes 表删该 thread 所有快照
 *
 * 成功返回 204 No Content(REST 惯例:删除操作不返回内容)。
 *
 * 不存在的 id 也返回 204(幂等性):
 *   - iOS 多次点删除按钮不会报错
 *   - 不暴露"这个 id 存在不存在"的信息
 */
app.delete("/api/threads/:id", async (req: Request, res: Response) => {
  // 同 GET /api/threads/:id/messages 那里,类型守卫收窄 req.params.id
  const rawId = req.params.id;
  const threadId = typeof rawId === "string" ? rawId.trim() : undefined;

  if (!threadId) {
    res.status(400).json({ error: "Thread id is required." });
    return;
  }

  try {
    await deleteThread(threadId);
    res.status(204).end();
  } catch (error) {
    console.error(`[Threads] delete failed for ${threadId}:`, error);
    res.status(500).json({ error: "Failed to delete thread." });
  }
});

// ════════════════════════════════════════════════════════════════════
// Phase 10.1 #2 — 用户反馈接口(写回 LangSmith Feedback)
// ════════════════════════════════════════════════════════════════════
//
// 这个接口的作用很纯粹:让 iOS 端把"用户点了 👍/👎"这件事
// 写回到对应那条 LangSmith trace 上,变成 trace 详情页里的 Feedback。
//
// 为什么 trace 之外还要做 feedback:
// - trace 告诉你"模型这次怎么思考、调了什么 tool、花了多少 token"——客观技术指标
// - feedback 告诉你"用户觉得这次回答好不好"——主观业务指标
// - 两者关联起来,才能回答"哪种 tool 链路用户满意度最高""哪个 prompt
//   改动让满意度下降了"这类问题。这是 LangSmith Evaluation 体系的"人工监督环"。
//
// 实现上极简,因为重活都在 langsmithClient.ts 里:
//   server.ts 只负责"HTTP 校验 + 错误码翻译",
//   langsmithClient 负责"调 SDK + 单例管理"。

/**
 * POST /api/feedback
 *
 * 请求体:{ run_id, score, key?, comment? }
 *   - run_id: 来自 SSE done 事件(#3 会加)
 *   - score: 0..1 浮点;iOS 端 👍=1 / 👎=0
 *   - key: 可选,默认 "user_thumb"
 *   - comment: 可选用户备注
 *
 * 返回:201 + { feedback_id }
 *
 * 状态码约定:
 * - 400  请求体非法(缺 run_id / score 不是 0..1 浮点)
 * - 503  服务端没启用 LangSmith,无法记录(明确告诉前端"不是临时网络问题")
 * - 500  其它(LangSmith API 鉴权失败 / runId 不存在 / 网络)
 */
app.post(
  "/api/feedback",
  async (
    req: Request,
    res: Response<FeedbackResponseBody | ErrorResponseBody>
  ) => {
    const body = (req.body ?? {}) as FeedbackRequestBody;

    /**
     * 校验 run_id。
     *
     * 不做 UUID 格式校验——LangSmith run id 是 UUID 格式没错,
     * 但格式校验交给 LangSmith 服务端做更稳(版本升级也不用改这里)。
     * 这里只挡"空 / 非字符串"这种明显错误。
     */
    const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
    if (!runId) {
      res.status(400).json({ error: "run_id is required." });
      return;
    }

    /**
     * 校验 score。
     *
     * Number.isFinite 同时过滤 NaN / Infinity / 非数字。
     * 约束在 [0, 1] 是 LangSmith 标准评分范围——超出范围在 LangSmith UI
     * 里会显示异常,不如这里直接拒掉给前端更清晰的错误。
     */
    const score = body.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      res.status(400).json({ error: "score must be a finite number between 0 and 1." });
      return;
    }

    /**
     * key / comment 都是可选,做最基本的"是字符串才用"清洗。
     * comment 限长 1000 字,防止有人灌大文本——这是边界值,
     * LangSmith 服务端也有上限,但提前在我们这里挡住更省 SDK 调用。
     */
    const key =
      typeof body.key === "string" && body.key.trim() ? body.key.trim() : undefined;
    const comment =
      typeof body.comment === "string" && body.comment.trim()
        ? body.comment.trim().slice(0, 1000)
        : undefined;

    try {
      const { feedbackId } = await submitUserFeedback({
        runId,
        score,
        key,
        comment,
      });

      console.log(
        `[Feedback] saved id=${feedbackId} runId=${runId} score=${score} key=${key ?? "user_thumb"}`
      );

      res.status(201).json({ feedback_id: feedbackId });
    } catch (error) {
      if (error instanceof LangSmithFeedbackDisabledError) {
        /**
         * 503 Service Unavailable 比 500 更合适:
         * - 500 暗示"服务挂了,等会再试"
         * - 503 暗示"这个能力当前不可用"(更准确)
         * 前端拿到 503 应该提示用户"反馈功能未启用",而不是无脑重试。
         */
        console.warn("[Feedback] rejected:", error.message);
        res.status(503).json({ error: error.message });
        return;
      }

      console.error("[Feedback] submit failed:", error);
      res.status(500).json({ error: "Failed to submit feedback." });
    }
  }
);

app.listen(port, () => {
  console.log(`AI backend is running at http://localhost:${port}`);
  /**
   * 第三阶段：进程启动时打印一次 LangSmith trace 状态。
   *
   * LangSmith 本身不需要任何 SDK 代码——只要 .env 里有
   * LANGSMITH_TRACING=true / LANGSMITH_API_KEY，LangChain 就会自动上报。
   * 这里打印是为了让你能在控制台一眼看出当前请求会不会被 trace。
   */
  logLangSmithStatus();
});
