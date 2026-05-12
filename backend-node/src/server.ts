
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
  answer: string;
};

type ErrorResponseBody = {
  error: string;
};


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
Node.js 把 answer 返回给 iOS
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

      const instructions =
        systemPrompt ||
        "You are a helpful AI assistant. Explain concepts clearly and simply for a mobile developer learning iOS, SwiftUI, and AI application development.";
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

      res.json({
        answer: completion.choices[0]?.message?.content || "",
      });
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
