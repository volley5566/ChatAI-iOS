/**
 * ═══════════════════════════════════════════════════════════════════
 * server.ts — Express 路由入口
 * ═══════════════════════════════════════════════════════════════════
 *
 * 整个后端的 HTTP 入口。只负责两件事:
 *   1. 接收请求、校验参数、返回响应
 *   2. 把业务逻辑委派给对应模块
 *
 * 不做任何 AI / 工具 / 数据库的具体实现——那些都在子模块里。
 *
 * 暴露的接口一览:
 *   GET  /health                    健康检查
 *   POST /api/chat                  非流式结构化 JSON(最早期接口）
 *   POST /api/chat/stream           普通流式回答（固定 RAG，无工具）
 *   POST /api/agent/stream    ★     核心链路: Agent + Tool + MCP + SSE
 *   POST /api/threads               新建对话
 *   GET  /api/threads               列出对话
 *   GET  /api/threads/:id/messages  拉对话消息
 *   DELETE /api/threads/:id         删除对话
 *   POST /api/feedback              用户 👍/👎 写回 LangSmith
 *
 * 模块职责拆分:
 *   config/env.ts        环境变量
 *   langchain/*          LangChain RAG、ChatDeepSeek、Tool、Agent
 *   chat/*               普通聊天上下文、history 清洗、prompt、结构化解析
 *   knowledge/*          RAG 知识库
 *   agent/*              Agent 灰度路由、SSE 事件辅助、结构化日志
 *   mcp/*                MCP client/server 与真实工具实现
 *   db/*                 Prisma + SqliteCheckpointer 持久化
 *   http/sse.ts          SSE 输出
 *   shared/types.ts      共享类型
 */

import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { runLangChainAgentStream } from "./agent/agentRunner";
import { scheduleMemoryWrite } from "./memory/memoryWriter";
import {
  forkThreadFromCheckpoint,
  getPendingApprovalForThread,
  listCheckpointsForThread,
} from "./langchain/agentGraph";
import { randomUUID } from "crypto";
import type { ToolApprovalResponse } from "./langchain/agentGraphNodes";
import {
  createAgentRequestId,
  getDurationMs,
  logAgentError,
  logAgentInfo,
} from "./agent/agentObservability";
import { logChatContext, prepareChatCompletion } from "./chat/chatCompletion";
import { sanitizeChatHistory } from "./chat/chatHistory";
import {
  logLangSmithStatus,
  memoryWriteEnabled,
  model,
  port,
  useLangGraph,
} from "./config/env";
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

// ═══════════════════════════════════════════════════════════════════
// Express 应用初始化 + 中间件
// ═══════════════════════════════════════════════════════════════════

const app = express();

/**
 * Helmet — 一行代码给每个 HTTP 响应自动加十几个安全头:
 *   X-Content-Type-Options: nosniff   防止浏览器猜 MIME 类型(XSS 防护)
 *   X-Frame-Options: SAMEORIGIN       防止页面被嵌入 iframe(点击劫持)
 *   Strict-Transport-Security         强制 HTTPS
 *   ...
 *
 * 不影响 API 行为,纯安全加固。
 * Android 类比: AndroidManifest 里的 android:usesCleartextTraffic="false"。
 */
app.use(helmet());

// 允许 iOS / 浏览器跨域访问
app.use(cors());

/**
 * Rate Limiting — 限流,防止恶意脚本烧光 DeepSeek API 余额。
 *
 * 规则: 同一 IP,15 分钟内最多 100 次请求,超了返回 429 Too Many Requests。
 * standardHeaders: true → 响应头带 RateLimit-* 字段,iOS 可以读它做 UI 提示。
 *
 * Android 类比: OkHttp Interceptor 里的频率检查,超限直接 429 不往下游发。
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// 只给 /api 路径加限流(健康检查 /health 不限)
app.use("/api", apiLimiter);

/**
 * express.json() 让后端能读取 JSON 请求体。
 * limit: "1mb" 限制请求体大小,防止用户传超大内容。
 */
app.use(express.json({ limit: "1mb" }));

// ═══════════════════════════════════════════════════════════════════
// 健康检查
// ═══════════════════════════════════════════════════════════════════

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "ai-ios-chat-backend",
  });
});

/**
 * Phase 12 — 从请求里取"当前用户 id"。
 *
 * # 身份为什么走 HTTP 头而不是请求体
 *   userId 是一个**横切关注点**(每个接口都要,但又不属于业务参数),
 *   放在 `X-User-Id` 头里,GET / POST / DELETE 全都能统一带上,
 *   不用给每个 body / query 单独加字段。这是身份类信息的常见做法。
 *
 * # 这不是鉴权
 *   现阶段后端**完全信任**这个头里的值(iOS 本地生成的匿名 UUID),
 *   不做任何校验/签名。它的作用只是"给数据分租户",好让 Phase 12 的
 *   跨对话记忆能按用户隔离。将来要做真正的登录鉴权,把这里换成
 *   "解析 JWT → 取 sub" 即可,上层业务代码不用动。
 *
 * 没传头 → 返回 undefined → 退回匿名行为(向后兼容老版本 iOS)。
 */
function getUserId(req: Request): string | undefined {
  return req.header("x-user-id")?.trim() || undefined;
}

// ═══════════════════════════════════════════════════════════════════
// /api/chat — 非流式结构化 JSON(最早期接口)
// ═══════════════════════════════════════════════════════════════════
//
// 链路: LangChain Retriever → ChatPromptTemplate → ChatDeepSeek → JSON parser
// 返回结构化 JSON(title / summary / points / next_question),iOS 展示卡片。

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
        res.status(400).json({ error: "Message cannot be empty." });
        return;
      }

      const { knowledgeMatches, langChainMessages } = await prepareChatCompletion(
        message, systemPrompt, history, "structured"
      );
      logChatContext("structured", knowledgeMatches, history);

      const rawAnswer = await invokeLangChainChat(langChainMessages);
      const structuredAnswer = parseStructuredAnswer(rawAnswer);
      res.json(structuredAnswer);
    } catch (error) {
      console.error("Chat API error:", error);
      res.status(500).json({ error: "Failed to generate AI response." });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// /api/chat/stream — 普通流式聊天(固定 RAG,不走 Agent)
// ═══════════════════════════════════════════════════════════════════
//
// 和 /api/agent/stream 的区别:
//   - 这里只做 RAG 检索 + 流式输出,不调用任何工具
//   - 没有 ReAct 循环,没有 tool_start / tool_done 事件
//   - 保留这条接口是为了对比不同阶段的实现差异

app.post(
  "/api/chat/stream",
  async (req: Request, res: Response<ErrorResponseBody>) => {
    let clientClosed = false;
    res.on("close", () => { clientClosed = true; });

    try {
      const body = req.body as ChatRequestBody;
      const message = body.message?.trim();
      const systemPrompt = body.system_prompt?.trim();
      const history = sanitizeChatHistory(body.history);

      if (!message) {
        res.status(400).json({ error: "Message cannot be empty." });
        return;
      }

      const { knowledgeMatches, langChainMessages } = await prepareChatCompletion(
        message, systemPrompt, history, "streaming"
      );
      logChatContext("streaming", knowledgeMatches, history);

      // 设置 SSE 响应头: 后端不是一次性返回 JSON,而是保持连接不断推送事件
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const stream = streamLangChainChat(langChainMessages);

      for await (const delta of stream) {
        if (clientClosed) break;
        if (delta) {
          writeSseEvent(res, { type: "delta", delta });
        }
      }

      if (!clientClosed) {
        writeSseEvent(res, { type: "done" });
      }
      res.end();
    } catch (error) {
      console.error("Streaming Chat API error:", error);

      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream AI response." });
        return;
      }
      if (!clientClosed) {
        writeSseEvent(res, { type: "error", error: "Failed to stream AI response." });
      }
      res.end();
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// /api/agent/stream ★ 核心链路
// ═══════════════════════════════════════════════════════════════════
//
// 完整流程:
//   iOS 发 { message, thread_id }
//     → 参数校验 + touchThread(自动创建/刷新对话)
//     → runLangChainAgentStream(灰度路由到 Phase 3 或 Phase 4)
//       → Agent ReAct 循环: 模型 → 工具 → 模型 → ... → 最终回答
//     → SSE 推送 tool_start / tool_done / delta / done 给 iOS
//
// SSE 事件类型:
//   tool_start  → iOS 显示"正在查询知识库..."
//   tool_done   → iOS 更新"已查询,找到 N 条"
//   delta       → iOS 逐字追加 AI 回答
//   done        → 本次回答结束(附带 run_id + token 用量)
//   error       → 出错了

app.post(
  "/api/agent/stream",
  async (req: Request, res: Response<ErrorResponseBody>) => {
    /**
     * requestId 是本次请求的"链路编号",会出现在三个地方:
     *   1. X-Request-ID 响应头 — HTTP 调试工具查看
     *   2. SSE event.request_id — iOS 端展示/上报
     *   3. 后端结构化日志 — 按 requestId 可以 grep 出整条链路
     */
    const requestId = createAgentRequestId();
    const requestStartedAt = Date.now();
    let clientClosed = false;
    let responseCompleted = false;
    // activePhase 标记当前阶段,catch 里用它记录错误发生在哪步
    let activePhase = "request_validation";

    /**
     * Agent 专用 SSE 写入函数。
     * 和普通聊天不同,Agent 链路更长(有工具阶段),
     * 所以每条事件都补上 request_id,让客户端和服务端日志能对齐。
     */
    const writeAgentSseEvent = (event: ChatStreamEvent) => {
      writeSseEvent(res, { ...event, request_id: requestId });
    };

    res.setHeader("X-Request-ID", requestId);

    // 监听 iOS 断连(用户退出页面 / 取消请求 / 网络断开)
    res.on("close", () => {
      clientClosed = true;
      if (!responseCompleted) {
        logAgentInfo(requestId, "http", "client_closed", {
          durationMs: getDurationMs(requestStartedAt),
          activePhase,
        });
      }
    });

    try {
      // ── 1. 参数解析与校验 ─────────────────────────────────────

      /**
       * as ChatRequestBody 是 TypeScript 类型断言,
       * 告诉 TS:"我认为 req.body 符合 ChatRequestBody 这个类型。"
       */
      const body = req.body as ChatRequestBody;

      /**
       * ?. 是可选链(optional chaining):
       * 如果 body.message 存在就执行 .trim(),不存在就返回 undefined。
       */
      const message = body.message?.trim();
      const systemPrompt = body.system_prompt?.trim();

      // 清洗历史消息,过滤掉客户端可能乱传的 system / tool 角色
      const history = sanitizeChatHistory(body.history);

      /**
       * 解析 thread_id(对话 ID):
       *   - trim 去前后空格
       *   - 空字符串视为没传,转成 undefined
       *   - 不校验 UUID 格式,让 iOS / 测试脚本灵活用任意字符串
       *
       * 有 threadId → 启用 checkpointer 持久化(后端管理对话历史)
       * 没 threadId → 走无持久化模式(靠客户端 history 数组带历史)
       */
      const rawThreadId = body.thread_id?.trim();
      const threadId = rawThreadId || undefined;

      // Phase 12:取当前用户 id(来自 X-User-Id 头,可能为空 → 匿名)。
      const userId = getUserId(req);

      /**
       * 有 threadId 就 touch 一下 threads 表(Prisma upsert):
       *   - 不存在 → 自动创建(iOS 直接发消息不必先调 POST /api/threads)
       *   - 已存在 → 刷新 updatedAt(对话列表按最近活跃排序)
       *   - Phase 12:带上 userId,把对话挂到该用户名下(老对话会被自动回填)
       *
       * 故意不 try/catch: db 都写不了,后续 checkpointer 也大概率出问题,早 fail 早暴露。
       */
      if (threadId) {
        await touchThread(threadId, userId);
      }

      logAgentInfo(requestId, "request", "received", {
        // 不记录完整 message 内容,避免用户输入进入日志;只记长度/数量足够排查
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
        res.status(400).json({ error: "Message cannot be empty." });
        responseCompleted = true;
        return;
      }

      // ── 2. 建立 SSE 连接 ──────────────────────────────────────

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      // flushHeaders() 立刻发出响应头,不等 body。iOS 能更快收到,nginx 也不会缓冲。
      res.flushHeaders();

      // ── 3. 调 Agent Runner ────────────────────────────────────

      activePhase = "langchain_agent";
      const agentStartedAt = Date.now();
      let deltaCount = 0;
      let outputCharCount = 0;

      /**
       * runLangChainAgentStream 是灰度入口(agent/agentRunner.ts):
       *   USE_LANGGRAPH=false → Phase 3 createAgent 路径
       *   USE_LANGGRAPH=true  → Phase 4 手写 StateGraph 路径
       * 两条路径签名一致,这里不感知差异。
       */
      const agentRun = await runLangChainAgentStream({
        requestId,
        message,
        systemPrompt,
        history,
        threadId,
        // Phase 12:把用户身份带进去,LangGraph 路径用它召回跨对话记忆
        userId,
        // 工具进度回调: 工具事件 → 转成 SSE 推给 iOS
        onToolEvent: (event) => {
          if (!clientClosed) {
            writeAgentSseEvent({ ...event, phase: "tool_execution" });
          }
        },
        // token 流式回调: 模型每吐一个 token → 转成 SSE delta 推给 iOS
        onDelta: (delta) => {
          if (clientClosed) return;
          deltaCount += 1;
          outputCharCount += delta.length;
          writeAgentSseEvent({ type: "delta", delta, phase: "final_stream" });
        },
        // 提前终止信号: iOS 断连后返回 true,Agent 会优雅退出
        shouldStop: () => clientClosed,
      });

      // ── 4. Agent 跑完,收尾 ────────────────────────────────────

      logAgentInfo(requestId, "langchain_agent", "server_observed_completed", {
        durationMs: getDurationMs(agentStartedAt),
        modelCalledTools: agentRun.toolCallCount > 0,
        toolCallCount: agentRun.toolCallCount,
        deltaCount,
        outputCharCount,
        usage: agentRun.usage,
      });

      // iOS 已断连,不再写 SSE
      if (clientClosed) {
        logAgentInfo(requestId, "request", "stopped_after_client_close", {
          durationMs: getDurationMs(requestStartedAt),
          activePhase,
        });
        responseCompleted = true;
        res.end();
        return;
      }

      const totalDurationMs = getDurationMs(requestStartedAt);

      logAgentInfo(requestId, "final_stream", "completed", {
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
       * 发送 done 事件,表示本次回答结束。附带:
       *   run_id — LangSmith trace 的根 run UUID,iOS 存起来给 👍/👎 用
       *   prompt_tokens / completion_tokens / total_tokens — token 用量统计
       */
      writeAgentSseEvent({
        type: "done",
        phase: "request_completed",
        duration_ms: totalDurationMs,
        run_id: agentRun.rootRunId,
        prompt_tokens: agentRun.usage.promptTokens,
        completion_tokens: agentRun.usage.completionTokens,
        total_tokens: agentRun.usage.totalTokens,
        // HITL: 图被挂起在某个 tool_call 上 → 通知 iOS 展示审批卡片
        pending: agentRun.pending,
      });

      /**
       * Phase 12 #4 — 一轮对话正常结束 → 后台异步提炼并写入长期记忆。
       *
       * 触发条件:
       *   - memoryWriteEnabled  功能开启(默认 false)
       *   - threadId + userId    知道"哪段对话、记给谁"
       *   - !agentRun.pending     没有 HITL 挂起(挂起 = 这轮还没真结束)
       *
       * scheduleMemoryWrite 是 fire-and-forget:立刻返回,真正的 LLM 提炼 + 入库
       * 在响应发完后的下一个 tick 后台跑,失败只记日志,绝不影响用户。
       */
      if (memoryWriteEnabled && threadId && userId && !agentRun.pending) {
        scheduleMemoryWrite({ requestId, userId, threadId });
      }

      responseCompleted = true;
      res.end();
    } catch (error) {
      const totalDurationMs = getDurationMs(requestStartedAt);
      logAgentError(requestId, activePhase, "failed", error, {
        durationMs: totalDurationMs,
      });

      // SSE 还没建立 → 返回普通 HTTP 500 JSON
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to run AI agent." });
        responseCompleted = true;
        return;
      }

      // SSE 已建立 → 只能通过 SSE error 事件告诉 iOS
      if (!clientClosed) {
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

// ═══════════════════════════════════════════════════════════════════
// 对话管理接口(供 iOS 管理 thread 列表)
// ═══════════════════════════════════════════════════════════════════
//
// 都返回 JSON(不用 SSE,对话管理是离散操作)。
// 所有重活在 threadsRepository 里,路由层只做参数校验 + HTTP 响应包装。

/**
 * POST /api/threads — 新建对话。
 * body 可选 title(没传就 null,以后由模型生成)。
 * 返回新建的 thread summary,iOS 拿到 id 后用它发消息。
 *
 * 注意: iOS 也可以直接发 /api/agent/stream 带新 id 跳过这个接口,
 * 因为 /api/agent/stream 内部 touchThread 会自动创建。
 */
app.post("/api/threads", async (req: Request, res: Response) => {
  try {
    const body = req.body as { title?: string };
    // Phase 12:把新对话挂到当前用户名下(X-User-Id 头,可能为空 → 匿名对话)。
    const thread = await createThread({
      title: body.title,
      userId: getUserId(req),
    });
    res.status(201).json(thread);
  } catch (error) {
    console.error("[Threads] create failed:", error);
    res.status(500).json({ error: "Failed to create thread." });
  }
});

/**
 * GET /api/threads — 列出所有对话,按最近活跃倒序。
 * iOS 对话列表页启动时拉一次。
 * 用 { threads: [...] } 包一层,将来加分页字段(total / next_cursor)不破坏协议。
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
 * GET /api/threads/:id/messages — 拉某个对话的可展示消息。
 * 只返回 user / assistant 两类,Agent 内部消息(ToolMessage 等)已过滤。
 */
app.get("/api/threads/:id/messages", async (req: Request, res: Response) => {
  /**
   * Express 的 req.params.id 类型是 string | string[]
   * (Express 防御性类型,虽然 ":id" 路径参数实际只会是 string)。
   * 用 typeof 守卫收窄到 string。
   */
  const rawId = req.params.id;
  const threadId = typeof rawId === "string" ? rawId.trim() : undefined;

  if (!threadId) {
    res.status(400).json({ error: "Thread id is required." });
    return;
  }

  try {
    // Phase 11 #5 — payload 现在带 { messages, summary } 两个字段。
    // summary 为空串 = 还没压缩过 / 老对话没这个 channel,iOS 不显示压缩提示。
    const payload = await getThreadMessages(threadId);
    res.json(payload);
  } catch (error) {
    console.error(`[Threads] get messages failed for ${threadId}:`, error);
    res.status(500).json({ error: "Failed to load thread messages." });
  }
});

/**
 * DELETE /api/threads/:id — 删除对话。
 *
 * 双向删:
 *   - Prisma threads 表删一行
 *   - LangGraph checkpoints / writes 表删该 thread 所有快照
 *
 * 返回 204 No Content(REST 惯例: 删除操作不返回内容)。
 * 不存在的 id 也返回 204(幂等性): iOS 多次点删除不报错。
 */
app.delete("/api/threads/:id", async (req: Request, res: Response) => {
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

// ═══════════════════════════════════════════════════════════════════
// HITL — 人工审核接口
// ═══════════════════════════════════════════════════════════════════
//
// 这两个接口配合 /api/agent/stream 的 SSE done.pending 一起工作:
//
//   1. iOS 发 /api/agent/stream → 模型决定调 evaluateAnswer
//   2. toolNode 在 interrupt() 处挂起 → done.pending 通知 iOS
//   3. iOS 重连 / 切回后用 GET /pending 查"还有没有等审批的"
//   4. 用户在卡片上点[批准]/[拒绝] → POST /resume 续跑(SSE 流式响应)
//
// 注意:HITL 只在 USE_LANGGRAPH=true 路径生效。Phase 3 createAgent
// 没接 checkpointer 无法挂起,这两个接口会返回 503。

/**
 * GET /api/threads/:id/pending
 *
 * 查询某 thread 是否有挂起的工具批准请求。
 *
 * 返回:
 *   200 + { pending: PendingToolApproval | null }
 *   400 thread_id 缺失
 *   503 USE_LANGGRAPH=false 时不可用
 */
app.get("/api/threads/:id/pending", async (req: Request, res: Response) => {
  if (!useLangGraph) {
    res.status(503).json({
      error: "HITL requires USE_LANGGRAPH=true. Phase 3 createAgent does not persist state.",
    });
    return;
  }

  const rawId = req.params.id;
  const threadId = typeof rawId === "string" ? rawId.trim() : "";
  if (!threadId) {
    res.status(400).json({ error: "Thread id is required." });
    return;
  }

  try {
    const pending = await getPendingApprovalForThread(threadId);
    res.status(200).json({ pending });
  } catch (error) {
    console.error(`[HITL] get pending failed for ${threadId}:`, error);
    res.status(500).json({ error: "Failed to query pending approval." });
  }
});

/**
 * POST /api/threads/:id/resume
 *
 * 续跑挂起的图。SSE 流式响应,语义和 /api/agent/stream 一致
 * (因为图续跑后还会继续吐 delta / tool 事件,可能再次 pending)。
 *
 * body: { approved: boolean, edited_args?: object }
 *   approved=true  → 用 args(或 edited_args)执行工具
 *   approved=false → 跳过工具,塞一条 "user denied" ToolMessage 给模型,让它改口
 *
 * 错误:
 *   400  thread_id 缺失 / body 格式错
 *   503  USE_LANGGRAPH=false
 *   404  该 thread 当前没挂起的工具(已经被 resume 过 / 从未挂起)
 */
app.post(
  "/api/threads/:id/resume",
  async (req: Request, res: Response<ErrorResponseBody>) => {
    const requestId = createAgentRequestId();
    const requestStartedAt = Date.now();
    let clientClosed = false;
    let responseCompleted = false;
    let activePhase = "request_validation";

    const writeAgentSseEvent = (event: ChatStreamEvent) => {
      writeSseEvent(res, { ...event, request_id: requestId });
    };

    res.setHeader("X-Request-ID", requestId);
    res.on("close", () => {
      clientClosed = true;
      if (!responseCompleted) {
        logAgentInfo(requestId, "http", "client_closed", {
          durationMs: getDurationMs(requestStartedAt),
          activePhase,
        });
      }
    });

    try {
      if (!useLangGraph) {
        res.status(503).json({
          error: "HITL requires USE_LANGGRAPH=true.",
        });
        responseCompleted = true;
        return;
      }

      const rawId = req.params.id;
      const threadId = typeof rawId === "string" ? rawId.trim() : "";
      if (!threadId) {
        res.status(400).json({ error: "Thread id is required." });
        responseCompleted = true;
        return;
      }

      // 校验 body
      const body = (req.body ?? {}) as Partial<ToolApprovalResponse>;
      if (typeof body.approved !== "boolean") {
        res.status(400).json({ error: "body.approved must be boolean." });
        responseCompleted = true;
        return;
      }

      const decision: ToolApprovalResponse = {
        approved: body.approved,
        edited_args:
          body.edited_args && typeof body.edited_args === "object"
            ? (body.edited_args as Record<string, unknown>)
            : undefined,
      };

      // 防御性检查: 没挂起就 resume 是 no-op,提前告诉调用方避免误用
      const pending = await getPendingApprovalForThread(threadId);
      if (!pending) {
        res.status(404).json({
          error: "No pending tool approval for this thread.",
        });
        responseCompleted = true;
        return;
      }

      logAgentInfo(requestId, "hitl_resume", "received", {
        threadId,
        toolName: pending.tool_name,
        approved: decision.approved,
        edited: Boolean(decision.edited_args),
      });

      // 续跑过程中可能再次刷新 thread updatedAt(Phase 12:一并带上用户归属)
      await touchThread(threadId, getUserId(req));

      // ── 建立 SSE ─────────────────────────────────────────────
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      activePhase = "langgraph_agent_resume";
      const agentStartedAt = Date.now();
      let deltaCount = 0;
      let outputCharCount = 0;

      // 调灰度入口续跑(message 字段在续跑时被忽略,但接口要求传)
      const agentRun = await runLangChainAgentStream({
        requestId,
        message: "",
        systemPrompt: undefined,
        history: [],
        threadId,
        // Phase 12:对齐传入(resume 不经过 recall 节点,这里其实用不到,
        // 但保持和主流程一致,避免遗漏)
        userId: getUserId(req),
        resumePayload: decision,
        onToolEvent: (event) => {
          if (!clientClosed) {
            writeAgentSseEvent({ ...event, phase: "tool_execution" });
          }
        },
        onDelta: (delta) => {
          if (clientClosed) return;
          deltaCount += 1;
          outputCharCount += delta.length;
          writeAgentSseEvent({ type: "delta", delta, phase: "final_stream" });
        },
        shouldStop: () => clientClosed,
      });

      if (clientClosed) {
        responseCompleted = true;
        res.end();
        return;
      }

      const totalDurationMs = getDurationMs(requestStartedAt);

      logAgentInfo(requestId, "hitl_resume", "completed", {
        durationMs: totalDurationMs,
        toolCallCount: agentRun.toolCallCount,
        deltaCount,
        outputCharCount,
        usage: agentRun.usage,
        rePending: agentRun.pending ? agentRun.pending.tool_name : "(none)",
      });

      writeAgentSseEvent({
        type: "done",
        phase: "request_completed",
        duration_ms: totalDurationMs,
        run_id: agentRun.rootRunId,
        prompt_tokens: agentRun.usage.promptTokens,
        completion_tokens: agentRun.usage.completionTokens,
        total_tokens: agentRun.usage.totalTokens,
        // 续跑后模型可能再次想调一个需要审批的工具,这里再次 pending
        pending: agentRun.pending,
      });

      // Phase 12 #4 — resume 后这轮也算正常结束(无再次挂起)→ 后台写记忆。
      const resumeUserId = getUserId(req);
      if (memoryWriteEnabled && resumeUserId && !agentRun.pending) {
        scheduleMemoryWrite({ requestId, userId: resumeUserId, threadId });
      }

      responseCompleted = true;
      res.end();
    } catch (error) {
      const totalDurationMs = getDurationMs(requestStartedAt);
      logAgentError(requestId, activePhase, "failed", error, {
        durationMs: totalDurationMs,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to resume agent." });
        responseCompleted = true;
        return;
      }

      if (!clientClosed) {
        writeAgentSseEvent({
          type: "error",
          error: "Failed to resume agent.",
          phase: activePhase,
          duration_ms: totalDurationMs,
        });
      }

      responseCompleted = true;
      res.end();
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// Time-travel — 时光机接口(Phase 9 #7)
// ═══════════════════════════════════════════════════════════════════
//
// 利用 LangGraph checkpointer 把每一步 state 都存了的特性,提供两个接口:
//
//   1. GET  /api/threads/:id/checkpoints  列出"用户可分叉的时刻"
//   2. POST /api/threads/:id/fork         从某个 checkpoint 分叉出新 thread
//
// 类比 git:thread 是分支,checkpoint 是 commit。
// fork 就是从某个 commit 拉一个新分支出去,原分支保持完整。

/**
 * GET /api/threads/:id/checkpoints
 *
 * 返回该 thread 的所有"用户可分叉时刻"(过滤掉工具调用中间态)。
 *
 * 返回:
 *   200 + { checkpoints: CheckpointSummary[] }
 *   400 thread_id 缺失
 *   503 USE_LANGGRAPH=false
 */
app.get(
  "/api/threads/:id/checkpoints",
  async (req: Request, res: Response) => {
    if (!useLangGraph) {
      res.status(503).json({
        error:
          "Time-travel requires USE_LANGGRAPH=true. Phase 3 createAgent does not persist state.",
      });
      return;
    }

    const rawId = req.params.id;
    const threadId = typeof rawId === "string" ? rawId.trim() : "";
    if (!threadId) {
      res.status(400).json({ error: "Thread id is required." });
      return;
    }

    try {
      const checkpoints = await listCheckpointsForThread(threadId);
      res.status(200).json({ checkpoints });
    } catch (error) {
      console.error(`[Time-travel] list checkpoints failed for ${threadId}:`, error);
      res.status(500).json({ error: "Failed to list checkpoints." });
    }
  }
);

/**
 * POST /api/threads/:id/fork
 *
 * 从指定 checkpoint 分叉出一个新 thread。
 *
 * body: { checkpoint_id: string, title?: string }
 *
 * 流程:
 *   1. 验证 source thread + checkpoint 都存在
 *   2. 生成新 thread_id (UUID)
 *   3. Prisma 创建新 thread 行(title 用 body.title 或自动生成 "...的分叉")
 *   4. LangGraph 把源 checkpoint 的 state 写到新 thread
 *   5. 返回新 thread 的 summary,iOS 拿到 id 跳转过去
 *
 * 返回:
 *   201 + ThreadSummary
 *   400 body 格式错 / thread_id 缺失
 *   404 source thread 或 checkpoint 不存在
 *   503 USE_LANGGRAPH=false
 */
app.post(
  "/api/threads/:id/fork",
  async (req: Request, res: Response) => {
    if (!useLangGraph) {
      res.status(503).json({
        error: "Time-travel requires USE_LANGGRAPH=true.",
      });
      return;
    }

    const rawId = req.params.id;
    const sourceThreadId = typeof rawId === "string" ? rawId.trim() : "";
    if (!sourceThreadId) {
      res.status(400).json({ error: "Source thread id is required." });
      return;
    }

    const body = (req.body ?? {}) as {
      checkpoint_id?: string;
      title?: string;
    };
    const checkpointId =
      typeof body.checkpoint_id === "string" ? body.checkpoint_id.trim() : "";
    if (!checkpointId) {
      res.status(400).json({ error: "body.checkpoint_id is required." });
      return;
    }

    // 生成新 thread_id — 在 LangGraph 写 state 之前先做,这样新 id
    // 在 Prisma 和 checkpointer 两边是同一个,后续查询能对得上
    const newThreadId = randomUUID();
    const customTitle =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : undefined;

    try {
      // 1. 复制 state 到新 thread(走 LangGraph updateState,不直接动 SQLite)
      const forkResult = await forkThreadFromCheckpoint({
        sourceThreadId,
        sourceCheckpointId: checkpointId,
        newThreadId,
      });

      // 2. Prisma 建新 thread 行
      //    标题默认:"原 thread 的分叉 · 共 N 条消息"
      const fallbackTitle = `分叉对话 · ${forkResult.messageCount} 条消息`;
      const newThread = await createThread({
        id: newThreadId,
        title: customTitle ?? fallbackTitle,
      });

      console.log(
        `[Time-travel] forked thread ${sourceThreadId} → ${newThreadId} ` +
          `at checkpoint ${checkpointId.slice(0, 8)}... (${forkResult.messageCount} messages)`
      );

      res.status(201).json(newThread);
    } catch (error) {
      // 常见失败:checkpoint_id 不存在 / source thread 没有 state
      // 错误信息里有 "no messages" → 当 404 处理,其它当 500
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Time-travel] fork failed: source=${sourceThreadId} ` +
          `checkpoint=${checkpointId}:`,
        error
      );

      if (/no messages|not found/i.test(message)) {
        res.status(404).json({
          error: "Source checkpoint not found or has no messages.",
        });
        return;
      }
      res.status(500).json({ error: "Failed to fork thread." });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// /api/feedback — 用户反馈(写回 LangSmith)
// ═══════════════════════════════════════════════════════════════════
//
// 让 iOS 端把"用户点了 👍/👎"写回到 LangSmith trace 上。
//
// 为什么要做 feedback:
//   trace 告诉你"模型怎么思考、调了什么 tool" — 客观技术指标
//   feedback 告诉你"用户觉得回答好不好" — 主观业务指标
//   两者关联起来才能分析"哪种 tool 链路满意度最高"。

/**
 * POST /api/feedback
 *
 * body: { run_id, score, key?, comment? }
 *   run_id — 来自 SSE done 事件
 *   score  — 0..1 浮点, iOS 👍=1 / 👎=0
 *   key    — 可选, 默认 "user_thumb"
 *   comment — 可选用户备注
 *
 * 返回: 201 + { feedback_id }
 * 错误: 400 参数非法 / 503 LangSmith 未启用 / 500 其它
 */
app.post(
  "/api/feedback",
  async (
    req: Request,
    res: Response<FeedbackResponseBody | ErrorResponseBody>
  ) => {
    const body = (req.body ?? {}) as FeedbackRequestBody;

    // 校验 run_id: 只挡空/非字符串,格式校验交给 LangSmith 服务端
    const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
    if (!runId) {
      res.status(400).json({ error: "run_id is required." });
      return;
    }

    /**
     * 校验 score:
     * Number.isFinite() 同时过滤 NaN / Infinity / 非数字。
     * 约束在 [0, 1] 是 LangSmith 标准评分范围。
     */
    const score = body.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      res.status(400).json({ error: "score must be a finite number between 0 and 1." });
      return;
    }

    // key / comment 可选,做基本的字符串清洗。comment 限长 1000 字防灌大文本。
    const key =
      typeof body.key === "string" && body.key.trim() ? body.key.trim() : undefined;
    const comment =
      typeof body.comment === "string" && body.comment.trim()
        ? body.comment.trim().slice(0, 1000)
        : undefined;

    try {
      const { feedbackId } = await submitUserFeedback({ runId, score, key, comment });

      console.log(
        `[Feedback] saved id=${feedbackId} runId=${runId} score=${score} key=${key ?? "user_thumb"}`
      );
      res.status(201).json({ feedback_id: feedbackId });
    } catch (error) {
      if (error instanceof LangSmithFeedbackDisabledError) {
        // 503 = "这个能力当前不可用",前端应提示"反馈功能未启用"而不是重试
        console.warn("[Feedback] rejected:", error.message);
        res.status(503).json({ error: error.message });
        return;
      }

      console.error("[Feedback] submit failed:", error);
      res.status(500).json({ error: "Failed to submit feedback." });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 启动服务
// ═══════════════════════════════════════════════════════════════════

app.listen(port, () => {
  console.log(`AI backend is running at http://localhost:${port}`);
  /**
   * LangSmith 不需要额外 SDK 代码——只要 .env 里有
   * LANGSMITH_TRACING=true + LANGSMITH_API_KEY,LangChain 就自动上报。
   * 这里打印一次状态,让你一眼看出当前请求会不会被 trace。
   */
  logLangSmithStatus();
});
