import express, { Request, Response } from "express";
import cors from "cors";
import { runLangChainAgentStream } from "./agent/agentRunner";
import {
  createAgentRequestId,
  getDurationMs,
  logAgentError,
  logAgentInfo,
} from "./agent/agentObservability";
import { logChatContext, prepareChatCompletion } from "./chat/chatCompletion";
import { sanitizeChatHistory } from "./chat/chatHistory";
import { model, port } from "./config/env";
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
} from "./shared/types";

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

// 允许 iOS / 浏览器跨域访问。
app.use(cors());

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
    const requestId = createAgentRequestId();
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

    res.setHeader("X-Request-ID", requestId);

    res.on("close", () => {
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

      logAgentInfo(requestId, "request", "received", {
        /**
         * 这里不记录完整 message 内容，避免用户输入进入后端日志。
         * 只记录长度、history 数量和是否有 system prompt，足够排查上下文规模问题。
         */
        route: "/api/agent/stream",
        model,
        messageLength: message?.length || 0,
        hasSystemPrompt: Boolean(systemPrompt),
        historyCount: history.length,
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
      res.flushHeaders();

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

      const agentRun = await runLangChainAgentStream({
        requestId,
        message,
        systemPrompt,
        history,
        onToolEvent: (event) => {
          if (!clientClosed) {
            writeAgentSseEvent({
              ...event,
              phase: "tool_execution",
            });
          }
        },
        onDelta: (delta) => {
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
        shouldStop: () => clientClosed,
      });

      logAgentInfo(requestId, "langchain_agent", "server_observed_completed", {
        durationMs: getDurationMs(agentStartedAt),
        modelCalledTools: agentRun.toolCallCount > 0,
        toolCallCount: agentRun.toolCallCount,
        deltaCount,
        outputCharCount,
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

        // 最后发送，表示本次回答结束。
        writeAgentSseEvent({
          type: "done",
          phase: "request_completed",
          duration_ms: totalDurationMs,
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

app.listen(port, () => {
  console.log(`AI backend is running at http://localhost:${port}`);
});
