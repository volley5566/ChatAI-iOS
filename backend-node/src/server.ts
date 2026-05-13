
//1. 导入依赖
/**
express：用来写 HTTP 接口
cors：处理跨域
dotenv：读取 .env 文件
OpenAI：这里使用 OpenAI SDK，实际请求会通过 baseURL 转发到 DeepSeek API
可以把 Express 理解成
Android / iOS 里的网络接口服务端框架
 */
import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
//2. 加载 .env
/**
 * 这行代码的作用是读取 .env 文件
 */
dotenv.config();
//3. 创建 Express 应用
/**
 * 创建一个后端 App
 * 这个 App 后面会监听端口 
 * http://localhost:8000
 */
const app = express();

//4. 添加 middleware
/**
 * cors() 是让外部客户端可以访问你的接口。
 * express.json() 是让后端可以解析 JSON 请求。
 */
app.use(cors());
app.use(express.json({ limit: "1mb" }));

//5. 读取配置
/**
 * port：后端服务端口
 * deepseekApiKey：你的 DeepSeek API Key
 * deepseekBaseURL：DeepSeek 的 OpenAI-compatible API 地址
 * model：使用哪个大模型
 */
const port = Number(process.env.PORT || 8000);//读取.env中的port
const deepseekApiKey = process.env.DEEPSEEK_API_KEY;//读取.env中的deepseek key
const deepseekBaseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

//6. 检查 API Key

if (!deepseekApiKey) {
  throw new Error("DEEPSEEK_API_KEY is missing. Please add it to your .env file.");
}

//7. 创建 DeepSeek 客户端
/**
 * DeepSeek API 兼容 OpenAI SDK。
 * 关键点是设置 baseURL，让 SDK 请求 DeepSeek 的接口。
 * DeepSeek 当前主要使用 Chat Completions API。
 */
const deepseek = new OpenAI({
  apiKey: deepseekApiKey,
  baseURL: deepseekBaseURL,
});


//8. 定义请求类型
/**
 iOS 会给后端传：
 {
  "message": "Explain SwiftUI @State",
  "system_prompt": "You are a senior iOS mentor..."
}
  message：用户的问题
  system_prompt：给 AI 的角色设定，可选
 */
type ChatRequestBody = {
  message?: string;
  system_prompt?: string;
};

type ChatResponseBody = {
  title: string;
  summary: string;
  points: string[];
  next_question: string;
};

type ErrorResponseBody = {
  error: string;
};

//8.1 定义结构化输出规则
/**
 * 第 3 阶段的核心目标：
 * 不再让 AI 随便返回一整段文字，
 * 而是要求 AI 返回固定 JSON 格式。
 *
 * 这样 iOS 就可以稳定地解析：
 * title         -> 标题
 * summary       -> 摘要
 * points        -> 重点列表
 * next_question -> 下一步建议问题
 */
const structuredOutputGuide = `
You must return only valid JSON.
Do not return Markdown.
Do not wrap the JSON in code fences.
Do not add any text before or after the JSON.

The JSON must match this exact shape:
{
  "title": "A short title in the user's language",
  "summary": "A clear short summary in the user's language",
  "points": [
    "Key point 1",
    "Key point 2",
    "Key point 3"
  ],
  "next_question": "A helpful follow-up question in the user's language"
}

Rules:
- title must be short.
- summary must be beginner-friendly.
- points must contain 2 to 5 short items.
- next_question must guide the user to continue learning.
`;

/**
 * 组合最终发给 AI 的 system prompt。
 *
 * systemPrompt：iOS 传来的角色设定，比如“你是 iOS 学习助手”
 * structuredOutputGuide：后端强制追加的 JSON 输出规则
 *
 * 为什么不直接只用 iOS 传来的 system_prompt？
 * 因为结构化输出是后端和 iOS 的接口契约，
 * 必须由后端保证，不能完全交给客户端随便覆盖。
 */
function buildInstructions(systemPrompt?: string): string {
  const rolePrompt =
    systemPrompt ||
    "You are a helpful AI assistant. Explain concepts clearly and simply for a mobile developer learning iOS, SwiftUI, and AI application development.";

  return `${rolePrompt}\n\n${structuredOutputGuide}`;
}

/**
 * 从 AI 返回的文本里提取 JSON。
 *
 * 理想情况下，AI 会严格只返回：
 * { "title": "...", ... }
 *
 * 但实际开发中，AI 偶尔可能会返回：
 * ```json
 * { ... }
 * ```
 *
 * 所以这里做一个轻量容错：
 * 取第一个 { 到最后一个 } 之间的内容再 JSON.parse。
 */
function extractJsonText(rawText: string): string {
  const startIndex = rawText.indexOf("{");
  const endIndex = rawText.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error("AI response does not contain a JSON object.");
  }

  return rawText.slice(startIndex, endIndex + 1);
}

/**
 * 把未知数据整理成 ChatResponseBody。
 *
 * JSON.parse 的结果类型是 unknown，不能直接相信。
 * 这个函数会检查字段类型，并提供默认值。
 * 这样即使 AI 少返回了某个字段，后端也能尽量给 iOS 一个稳定结构。
 */
function normalizeStructuredAnswer(
  value: unknown,
  rawAnswer: string
): ChatResponseBody {
  const data = value as Partial<Record<keyof ChatResponseBody, unknown>>;

  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : "AI 回答";

  const summary =
    typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : rawAnswer.trim() || "AI 已返回回答，但内容为空。";

  const points = Array.isArray(data.points)
    ? data.points
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  const nextQuestion =
    typeof data.next_question === "string" && data.next_question.trim()
      ? data.next_question.trim()
      : "你想继续了解哪一部分？";

  return {
    title,
    summary,
    points,
    next_question: nextQuestion,
  };
}

/**
 * 把 AI 原始文本转换成结构化响应。
 *
 * 如果解析成功：返回 AI 生成的结构化 JSON。
 * 如果解析失败：使用 fallback，把原始回答放进 summary。
 *
 * 这样做的好处：
 * iOS 永远能收到固定结构，不会因为 AI 格式偶发错误而崩溃。
 */
function parseStructuredAnswer(rawAnswer: string): ChatResponseBody {
  try {
    const jsonText = extractJsonText(rawAnswer);
    const parsed = JSON.parse(jsonText);

    return normalizeStructuredAnswer(parsed, rawAnswer);
  } catch (error) {
    console.warn("Failed to parse structured AI response:", error);

    return {
      title: "AI 回答",
      summary: rawAnswer.trim() || "AI 返回了空内容，请稍后再试。",
      points: [],
      next_question: "你想换一种方式再问一次吗？",
    };
  }
}


//9. 健康检查接口
/**
 * 这个接口只是用来测试后端是否启动成功。
 * 访问： curl http://localhost:8000/health
 * 应该返回：
 * {
 *  "status": "ok",
 *  "service": "ai-ios-chat-backend"
 * }
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "ai-ios-chat-backend",
  });
});

//10. 聊天接口
/**
 这个接口是给 iOS App 调用的。
 iOS 发 message
↓
Node.js 收到 message
↓
Node.js 调 DeepSeek Chat Completions API
↓
DeepSeek 返回回答
↓
Node.js 把结构化 JSON 返回给 iOS
 */
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

      if (!message) {
        res.status(400).json({
          error: "Message cannot be empty.",
        });
        return;
      }

      const instructions = buildInstructions(systemPrompt);
      //核心代码
      /**
       * DeepSeek 使用 OpenAI-compatible 的 Chat Completions API。
       * model：用哪个模型
       * messages：聊天上下文，system 是系统提示词，user 是用户输入
       */
      const completion = await deepseek.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: instructions,
          },
          {
            role: "user",
            content: message,
          },
        ],
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

app.listen(port, () => {
  console.log(`AI backend is running at http://localhost:${port}`);
});
