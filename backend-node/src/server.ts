import express, { Request, Response } from "express";
import cors from "cors";
import { runAgentToolLoop } from "./agentRunner";
import { logChatContext, prepareChatCompletion } from "./chatCompletion";
import { sanitizeChatHistory } from "./chatHistory";
import { model, port } from "./config";
import { deepseek } from "./deepseekClient";
import { writeSseEvent } from "./sse";
import { parseStructuredAnswer } from "./structuredAnswer";
import type { ChatRequestBody, ChatResponseBody, ErrorResponseBody } from "./types";

/**
 * server.ts 现在只负责 Express 路由和 HTTP 生命周期。
 *
 * 具体业务已经拆到独立模块：
 * - config.ts：环境变量
 * - deepseekClient.ts：模型客户端
 * - chatCompletion.ts：普通聊天上下文组装
 * - knowledge.ts：RAG 知识库
 * - agentTools.ts：Tool Calling 工具
 * - agentRunner.ts：Agent tool loop
 * - sse.ts：SSE 输出
 */
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

//9. 健康检查接口
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "ai-ios-chat-backend",
  });
});

//10. 聊天接口：非流式结构化 JSON
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

      const { knowledgeMatches, aiMessages } = prepareChatCompletion(
        message,
        systemPrompt,
        history,
        "structured"
      );

      logChatContext("structured", knowledgeMatches, history);

      const completion = await deepseek.chat.completions.create({
        model,
        messages: aiMessages,
      });

      const rawAnswer = completion.choices[0]?.message?.content || "";
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

//11. 普通流式聊天接口：固定 RAG + stream: true
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

      const { knowledgeMatches, aiMessages } = prepareChatCompletion(
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

      const stream = await deepseek.chat.completions.create({
        model,
        messages: aiMessages,
        stream: true,
      });

      for await (const chunk of stream) {
        if (clientClosed) {
          break;
        }

        const delta = chunk.choices[0]?.delta?.content;

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

//12. Agent 流式接口：Tool Calling + 工具状态可视化 + 最终流式回答
app.post(
  "/api/agent/stream",
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

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      console.log(`[Agent] history messages sent to AI: ${history.length}`);

      const agentRun = await runAgentToolLoop({
        deepseek,
        model,
        message,
        systemPrompt,
        history,
        onToolEvent: (event) => {
          if (!clientClosed) {
            writeSseEvent(res, event);
          }
        },
      });

      console.log(`[Agent] tool calls executed: ${agentRun.toolCallCount}`);

      if (clientClosed) {
        res.end();
        return;
      }

      /**
       * 工具调用阶段已经结束，这里不再传 tools / tool_choice。
       * 模型只能基于 agentRun.messages 里的工具结果生成最终文本。
       */
      const stream = await deepseek.chat.completions.create({
        model,
        messages: agentRun.messages,
        stream: true,
      });

      for await (const chunk of stream) {
        if (clientClosed) {
          break;
        }

        const delta = chunk.choices[0]?.delta?.content;

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
      console.error("Agent API error:", error);

      if (!res.headersSent) {
        res.status(500).json({
          error: "Failed to run AI agent.",
        });
        return;
      }

      if (!clientClosed) {
        writeSseEvent(res, {
          type: "error",
          error: "Failed to run AI agent.",
        });
      }

      res.end();
    }
  }
);

app.listen(port, () => {
  console.log(`AI backend is running at http://localhost:${port}`);
});
