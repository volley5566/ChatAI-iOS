
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
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
// fs/path 是 Node.js 自带模块。
// fs：读取 knowledge 目录里的 Markdown 文件。
// path：拼接不同系统下都安全的文件路径。
import fs from "fs";
import path from "path";
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
  "system_prompt": "You are a senior iOS mentor...",
  "history": [
    { "role": "user", "content": "@State 和 @Binding 有什么区别？" },
    { "role": "assistant", "content": "@State 保存当前 View 的状态..." }
  ]
}
  message：用户的问题
  system_prompt：给 AI 的角色设定，可选
  history：最近几条聊天历史，可选，用来解决“请更详细回答”这类上下文问题
 */
type ChatRequestBody = {
  message?: string;
  system_prompt?: string;
  history?: ChatHistoryItem[];
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

/**
 * iOS 发来的历史消息。
 *
 * 这里把字段定义成可选，是因为外部输入不能完全相信。
 * 后面会用 sanitizeChatHistory 做校验和清洗。
 */
type ChatHistoryItem = {
  role?: string;
  content?: string;
};

/**
 * 清洗后真正会发给 AI API 的历史消息。
 *
 * Chat Completions 里普通对话历史只需要两种 role：
 * - user：用户说过的话
 * - assistant：AI 之前回答过的话
 */
type NormalizedChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

/**
 * 一篇知识库文档在后端里的数据结构。
 *
 * fileName：文件名，例如 swiftui-state.md
 * title：Markdown 的一级标题，例如 SwiftUI @State
 * keywords：文档里的 Keywords 行，方便做关键词匹配
 * content：Markdown 原文内容，后面会拼进 prompt 给 AI 参考
 */
type KnowledgeDocument = {
  fileName: string;
  title: string;
  keywords: string[];
  content: string;
};

/**
 * 带相关性分数的知识库文档。
 *
 * score 越高，说明这篇文档越可能和用户问题相关。
 * 例如用户问 @State，swiftui-state.md 的分数就应该比较高。
 */
type ScoredKnowledgeDocument = {
  document: KnowledgeDocument;
  score: number;
};

/**
 * 后端目前有两种聊天输出模式。
 *
 * structured：
 * - 旧接口 /api/chat 使用
 * - AI 返回完整 JSON
 * - iOS 一次性解析成结构化卡片
 *
 * streaming：
 * - 新接口 /api/chat/stream 使用
 * - AI 返回普通文本流
 * - iOS 收到一小段就更新一次气泡
 */
type ChatResponseMode = "structured" | "streaming";

/**
 * 组装好的一次 AI 请求。
 *
 * 两个接口都需要：
 * - RAG 检索结果：用于日志和排查知识库命中情况
 * - Chat Completions messages：真正发给 DeepSeek 的上下文
 */
type PreparedChatCompletion = {
  knowledgeMatches: ScoredKnowledgeDocument[];
  aiMessages: ChatCompletionMessageParam[];
};

/**
 * SSE 发送给 iOS 的事件格式。
 *
 * 第一版只做三类事件：
 * - delta：一小段新生成的文本
 * - done：模型已经结束生成
 * - error：流式过程中出现错误
 *
 * 这里不用 data: [DONE]，而是统一用 JSON，
 * 是为了让 iOS 端只写一个 JSON 解码器即可处理所有事件。
 */
type ChatStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "done" }
  | { type: "error"; error: string };

/**
 * 第一版学习助手 Agent 支持的工具名。
 *
 * 这里先只做两个低风险工具：
 * - searchKnowledge：只读，查本地 Markdown 知识库
 * - generateQuiz：只生成练习题，不修改任何数据
 *
 * 后续接 MCP 或真实业务系统时，可以继续往这里扩展。
 */
type AgentToolName = "searchKnowledge" | "generateQuiz";

/**
 * searchKnowledge 工具的入参。
 *
 * query 是模型根据用户问题整理出来的搜索词。
 * 例如用户问“@State 和 @Binding 有什么区别”，
 * 模型可能会传入 "SwiftUI @State @Binding"。
 */
type SearchKnowledgeArguments = {
  query: string;
};

/**
 * generateQuiz 工具的入参。
 *
 * topic：练习题围绕的学习主题。
 * count：题目数量，可选；后端会把它限制在 1 到 5 之间，
 * 避免模型一次请求生成太多内容。
 */
type GenerateQuizArguments = {
  topic: string;
  count?: number;
};

/**
 * 后端执行工具后的统一结果格式。
 *
 * 为什么不直接把工具原始结果塞回模型？
 * 因为统一包装后，模型每次都能看到：
 * - toolName：这是谁的结果
 * - ok：工具是否成功
 * - result：成功时的数据
 * - error：失败时的原因
 *
 * 这会让最终回答更稳定，也方便以后增加更多工具。
 */
type AgentToolExecutionResult = {
  toolName: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

/**
 * DeepSeek V4 thinking mode 会在 assistant 消息里额外返回 reasoning_content。
 *
 * OpenAI SDK 的通用类型目前不包含这个 DeepSeek 扩展字段，
 * 但 DeepSeek 官方要求：
 * 如果某个 assistant 消息发起了 tool_call，
 * 后续请求必须把这条消息里的 reasoning_content 原样传回 API。
 *
 * 所以这里定义一个本地扩展类型，只在 Agent tool loop 内部使用。
 */
type DeepSeekAssistantMessageWithReasoning = ChatCompletionAssistantMessageParam & {
  reasoning_content?: string | null;
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
- All string values must be valid JSON strings.
- If you mention code that contains double quotes, escape the quotes or rewrite the example without double quotes.
- Do not put a JSON example inside any string value.
`;

/**
 * 流式输出接口使用的回答规则。
 *
 * 为什么不能复用 structuredOutputGuide？
 * - 结构化接口需要 AI 返回完整 JSON，方便 iOS 一次性解析成卡片。
 * - 流式接口需要用户立刻看到自然语言片段。
 *
 * 如果流式接口也要求 JSON，iOS 会先收到半截：
 * {"title":"...
 * 这对用户来说不是一段可读回答，也不适合第一版流式体验。
 *
 * 所以第一版 /api/chat/stream 先返回普通文本。
 * 等流式链路稳定后，可以再做“先流文本，结束后再返回结构化结果”的升级版。
 */
const streamingOutputGuide = `
Return a normal conversational answer, not JSON.
Do not wrap the whole answer in a JSON object.
Do not mention that you are streaming.
Keep the answer beginner-friendly and practical.
If code helps, include a short code example.
Use the same language as the user's question.
`;

/**
 * Agent 接口使用的额外规则。
 *
 * 普通 /api/chat/stream 是“后端固定做 RAG + 模型直接回答”。
 * /api/agent/stream 是“模型可以自己选择工具 + 后端执行工具 + 模型再回答”。
 *
 * 这里重点告诉模型：
 * - 什么时候应该用 searchKnowledge
 * - 什么时候应该用 generateQuiz
 * - 工具结果是事实来源，不能编造不存在的资料
 * - 最终回答仍然是普通文本，方便 iOS 继续用流式气泡展示
 */
const agentOutputGuide = `
You are an iOS learning assistant agent.

You can use tools when they help:
- Use searchKnowledge when the user asks about iOS, SwiftUI, this project, backend code, RAG, streaming, or a concept that may exist in the local knowledge base.
- Use generateQuiz when the user asks for exercises, practice questions, quizzes, review questions, or wants to test understanding.

Tool rules:
- Do not claim you used a tool unless a tool result is present.
- If a tool returns no useful result, say that clearly and continue with general beginner-friendly guidance.
- Do not invent source file names or knowledge base content.
- For final answers, write normal conversational text, not JSON.
- Use the same language as the user's question.
`;

/**
 * 默认角色设定。
 *
 * 结构化接口和流式接口都应该使用同一个默认角色，
 * 否则同一个问题在两个接口里可能出现风格不一致。
 */
const defaultRolePrompt =
  "You are a helpful AI assistant. Explain concepts clearly and simply for a mobile developer learning iOS, SwiftUI, and AI application development.";

function buildRolePrompt(systemPrompt?: string): string {
  return systemPrompt || defaultRolePrompt;
}

/**
 * 生成 RAG 提示词。
 *
 * 这个函数被结构化接口和流式接口共用：
 * - 有知识库命中时，要求 AI 优先参考知识库。
 * - 没有命中时，明确告诉 AI 使用通用知识回答。
 *
 * 抽出来的原因是：
 * 两个接口只应该在“输出格式”上不同，不应该在“如何使用知识库”上不同。
 */
function buildRagGuide(knowledgeContext?: string): string {
  return knowledgeContext
    ? `
Use the following knowledge base context as the primary reference.
If the context is relevant, base your answer on it.
If the context is not enough, you may add general knowledge, but keep the answer beginner-friendly.

Knowledge base context:
${knowledgeContext}
`
    : `
No matching knowledge base context was found for this question.
Answer with your general knowledge, but keep the answer beginner-friendly.
`;
}

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
function buildInstructions(systemPrompt?: string, knowledgeContext?: string): string {
  const rolePrompt = buildRolePrompt(systemPrompt);
  const ragGuide = buildRagGuide(knowledgeContext);

  /**
   * 最终 system prompt 的组成：
   *
   * 1. rolePrompt：AI 的角色，比如“你是 iOS 学习助手”
   * 2. ragGuide：RAG 检索到的知识库资料
   * 3. structuredOutputGuide：强制 AI 返回固定 JSON 格式
   *
   * 顺序很重要：
   * 先告诉 AI 参考资料，再告诉 AI 输出格式。
   */
  return `${rolePrompt}\n\n${ragGuide}\n\n${structuredOutputGuide}`;
}

/**
 * 组合流式接口使用的 system prompt。
 *
 * 它和 buildInstructions 的主要区别：
 * - buildInstructions：要求 AI 返回固定 JSON，适合 /api/chat。
 * - buildStreamingInstructions：要求 AI 返回普通自然语言，适合 /api/chat/stream。
 *
 * RAG 和角色设定仍然保持一致，这样两个接口回答同一问题时，
 * 只是在“返回格式”上不同，不会出现知识来源或语气完全不一致。
 */
function buildStreamingInstructions(
  systemPrompt?: string,
  knowledgeContext?: string
): string {
  const rolePrompt = buildRolePrompt(systemPrompt);
  const ragGuide = buildRagGuide(knowledgeContext);

  return `${rolePrompt}\n\n${ragGuide}\n\n${streamingOutputGuide}`;
}

/**
 * 组合 Agent 接口使用的 system prompt。
 *
 * 第一版 Agent 不再自动把 RAG context 塞进 system prompt，
 * 而是把“搜索知识库”暴露成 searchKnowledge 工具。
 *
 * 这样可以观察模型是否会根据任务自己决定调用工具，
 * 也更贴近后续接 MCP / 业务 API 的 Agent 工作方式。
 */
function buildAgentInstructions(systemPrompt?: string): string {
  const rolePrompt = buildRolePrompt(systemPrompt);

  return `${rolePrompt}\n\n${agentOutputGuide}`;
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
 * 去掉常见的 JSON 包装符号。
 *
 * 这个函数只用于 fallback。
 * 当 AI 没有返回合法 JSON 时，我们尽量把原始文本整理成用户能读的文字，
 * 避免把一整段 `{ "title": ... }` 原样显示在 iOS 页面上。
 */
function cleanupRawAnswerForDisplay(rawAnswer: string): string {
  return rawAnswer
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/^\s*\{\s*/, "")
    .replace(/\s*\}\s*$/, "")
    .trim();
}

/**
 * 从不合法 JSON 中尽量提取某个字段。
 *
 * 为什么需要它？
 * AI 偶尔会写出“看起来像 JSON，但其实不是合法 JSON”的内容。
 * 最常见的问题是字符串里出现了没有转义的双引号，例如：
 *
 * "points": [
 *   "Text("你好") 是一个 View"
 * ]
 *
 * 这会导致 JSON.parse 失败。
 * 但我们仍然可以用字段边界做一次尽力提取，避免 UI 直接显示原始 JSON。
 */
function extractJsonLikeField(
  rawAnswer: string,
  fieldName: string,
  nextFieldName?: string
): string | undefined {
  const startPattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const startMatch = startPattern.exec(rawAnswer);

  if (!startMatch) {
    return undefined;
  }

  const valueStartIndex = startMatch.index + startMatch[0].length;
  const valueEndPattern = nextFieldName
    ? new RegExp(`"\\s*,\\s*"${nextFieldName}"\\s*:`)
    : /"\s*[,}]?\s*$/;
  const restText = rawAnswer.slice(valueStartIndex);
  const endMatch = valueEndPattern.exec(restText);

  if (!endMatch) {
    return undefined;
  }

  return restText
    .slice(0, endMatch.index)
    .replace(/\\"/g, "\"")
    .trim();
}

/**
 * 从不合法 JSON 的 points 数组里尽量提取列表项。
 *
 * 这是一个“兜底解析器”，不是完整 JSON 解析器。
 * 它只服务于当前固定结构：
 * "points": [
 *   "第一点",
 *   "第二点"
 * ],
 * "next_question": "..."
 */
function extractJsonLikePoints(rawAnswer: string): string[] {
  const pointsMatch = rawAnswer.match(/"points"\s*:\s*\[([\s\S]*?)\]\s*,\s*"next_question"\s*:/);
  const pointsBlock = pointsMatch?.[1];

  if (!pointsBlock) {
    return [];
  }

  return pointsBlock
    .split(/\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^"/, "")
        .replace(/",?$/, "")
        .replace(/\\"/g, "\"")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 5);
}

/**
 * 当 JSON.parse 失败时，尽量把“像 JSON 的文本”整理回结构化回答。
 *
 * 这样即使 AI 输出格式有小问题，iOS 也还能显示：
 * title / summary / points / next_question
 *
 * 如果连字段都提取不到，才退回到普通摘要。
 */
function buildFallbackStructuredAnswer(rawAnswer: string): ChatResponseBody {
  const title = extractJsonLikeField(rawAnswer, "title", "summary") || "AI 回答";
  const summary =
    extractJsonLikeField(rawAnswer, "summary", "points") ||
    cleanupRawAnswerForDisplay(rawAnswer) ||
    "AI 返回了空内容，请稍后再试。";
  const points = extractJsonLikePoints(rawAnswer);
  const nextQuestion =
    extractJsonLikeField(rawAnswer, "next_question") || "你想换一种方式再问一次吗？";

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
 * 如果解析失败：使用 fallback，尽量从原始回答中提取字段。
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
    return buildFallbackStructuredAnswer(rawAnswer);
  }
}

//8.2 多轮上下文：清洗并限制最近聊天历史
/**
 * 每次最多带多少条历史消息。
 *
 * 这里选择 6 条，是一个适合 Demo 的平衡：
 * - 可以覆盖最近 3 轮 user/assistant 对话
 * - 能解决“请更详细回答”“继续”“举个例子”这类追问
 * - 不会让请求内容无限增长
 */
const maxHistoryMessages = 6;

/**
 * 每条历史消息最多保留多少字符。
 *
 * 如果不限制，长对话会导致：
 * - 请求变慢
 * - token 成本变高
 * - 超过模型上下文限制
 */
const maxHistoryContentCharacters = 1200;

function truncateHistoryContent(content: string): string {
  if (content.length <= maxHistoryContentCharacters) {
    return content;
  }

  return `${content.slice(0, maxHistoryContentCharacters)}\n...`;
}

/**
 * 清洗 iOS 传来的 history。
 *
 * 为什么要清洗？
 * history 来自客户端，后端不能完全相信：
 * - role 可能不是 user/assistant
 * - content 可能不是字符串
 * - 内容可能为空
 * - 历史可能非常长
 *
 * 清洗后，只保留最近几条合法消息，再发给 AI API。
 */
function sanitizeChatHistory(history: unknown): NormalizedChatHistoryItem[] {
  if (!Array.isArray(history)) {
    return [];
  }

  const normalizedHistory = history
    .map((item): NormalizedChatHistoryItem | undefined => {
      /**
       * history 是外部请求体的一部分，不能假设每一项都是对象。
       *
       * 例如调试接口、旧版本客户端、或者异常请求都可能传入：
       * - null
       * - 字符串 / 数字
       * - 数组
       *
       * 这些值都不是一条合法聊天历史，直接忽略即可。
       * 这里提前返回，可以避免下面读取 item.role 时出现运行时错误。
       */
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const historyItem = item as ChatHistoryItem;
      const role = historyItem.role;
      const content = historyItem.content;

      /**
       * 只允许 user / assistant 进入模型上下文。
       *
       * 不接受 system / tool 等角色，是为了避免客户端通过 history
       * 注入额外系统指令，影响后端统一维护的 system prompt 和输出格式规则。
       */
      if (role !== "user" && role !== "assistant") {
        return undefined;
      }

      /**
       * content 必须是字符串。
       *
       * 不能直接使用 content?.trim()：
       * 如果 content 是数字、对象或数组，?. 只能防 null/undefined，
       * 不能防“存在但类型不对”的值，仍然可能触发运行时错误。
       */
      if (typeof content !== "string") {
        return undefined;
      }

      /**
       * 空白消息没有上下文价值，也会浪费 token。
       * 先 trim 再截断，能避免一条全是空格的历史被误认为有效内容。
       */
      const trimmedContent = content.trim();

      if (!trimmedContent) {
        return undefined;
      }

      return {
        role,
        content: truncateHistoryContent(trimmedContent),
      };
    })
    .filter((item): item is NormalizedChatHistoryItem => Boolean(item));

  return normalizedHistory.slice(-maxHistoryMessages);
}

/**
 * RAG 检索时使用的查询文本。
 *
 * 只用当前 message 有一个问题：
 * 如果用户追问“请更详细回答”，这句话本身没有 @State/@Binding 等关键词，
 * 知识库就可能搜不到相关文档。
 *
 * 所以这里把“最近历史 + 当前问题”合在一起做检索，
 * 让追问也能继续命中上一轮相关资料。
 */
function buildRetrievalQuery(
  message: string,
  history: NormalizedChatHistoryItem[]
): string {
  const historyText = history.map((item) => item.content).join("\n");

  return `${historyText}\n${message}`.trim();
}

//8.2 轻量 RAG：读取 Markdown 知识库并做简单文本检索
/**
 * 第一版 RAG 不使用向量数据库。
 *
 * 它做的事情很直接：
 * 1. 读取 backend-node/knowledge/*.md
 * 2. 根据用户问题做关键词匹配
 * 3. 找出最相关的 2-3 篇文档
 * 4. 把这些文档片段拼进 prompt
 *
 * 这样 AI API 仍然会被调用，
 * 只是调用前多给了 AI 一些“参考资料”。
 */
/**
 * knowledgeDirectory 是知识库目录。
 *
 * 为什么这里用 __dirname + "../knowledge"？
 * - 开发环境：ts-node-dev 运行 src/server.ts，__dirname 是 backend-node/src
 * - 编译后：node dist/server.js，__dirname 是 backend-node/dist
 *
 * 这两种情况下，../knowledge 都会指向 backend-node/knowledge。
 */
const knowledgeDirectory = path.resolve(__dirname, "../knowledge");

// 每次最多取几篇相关文档，避免 prompt 太长。
const maxKnowledgeDocuments = 3;

/**
 * 最低相关性分数。
 *
 * 为什么需要这个阈值？
 * 轻量关键词检索会有“弱相关误命中”。
 * 例如 ios-networking-urlsession.md 里有一个 JSON 示例，
 * 示例文字中出现了 @State，所以用户问 @State 时它也可能拿到一点分。
 *
 * 但这种文档并不是真的在讲 @State。
 * 设置最低分数后，低分文档不会进入 prompt，回答会更干净。
 */
const minKnowledgeScore = 20;

// 每篇文档最多放多少字符进 prompt。
const maxCharactersPerDocument = 2600;

// 所有知识库 context 加起来最多多少字符。
const maxKnowledgeContextCharacters = 7000;

/**
 * stopWords 是一些搜索时意义不大的词。
 *
 * 例如用户问“@State 是什么”，里面“什么”不太能帮助判断文档相关性。
 * 去掉这些词后，关键词匹配会更稳定一点。
 */
const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "what",
  "why",
  "how",
  "this",
  "that",
  "is",
  "are",
  "was",
  "were",
  "什么",
  "怎么",
  "如何",
  "为什么",
  "这个",
  "那个",
  "区别",
]);

/**
 * 读取 knowledge 目录中的 Markdown 文件。
 *
 * 注意：
 * - README.md 是目录说明，不参与检索
 * - 每篇文档可以写 Keywords 行，帮助简单检索更准确
 */
function loadKnowledgeDocuments(): KnowledgeDocument[] {
  // 如果目录不存在，不让后端崩溃，只是打印警告并返回空数组。
  // 这样即使知识库目录被删了，普通 AI 问答仍然能工作。
  if (!fs.existsSync(knowledgeDirectory)) {
    console.warn(`Knowledge directory not found: ${knowledgeDirectory}`);
    return [];
  }

  /**
   * 找到所有 Markdown 文件。
   *
   * README.md 是给开发者看的目录说明，不作为知识资料参与检索。
   */
  const markdownFiles = fs
    .readdirSync(knowledgeDirectory)
    .filter((fileName) => fileName.endsWith(".md"))
    .filter((fileName) => fileName.toLowerCase() !== "readme.md")
    .sort();

  return markdownFiles.map((fileName) => {
    const filePath = path.join(knowledgeDirectory, fileName);

    // 读取 Markdown 原文。
    // 这里使用同步读取，是因为只在服务启动时读取一次，逻辑简单。
    const content = fs.readFileSync(filePath, "utf8");

    // 从 Markdown 的第一个 # 标题提取文档标题。
    // 如果没有标题，就退回使用文件名。
    const title = extractMarkdownTitle(content) || fileName;

    // 从 Keywords: 这一行提取关键词。
    // 例如：Keywords: SwiftUI, @State, state
    const keywords = extractMarkdownKeywords(content);

    return {
      fileName,
      title,
      keywords,
      content,
    };
  });
}

function extractMarkdownTitle(content: string): string | undefined {
  // 匹配 Markdown 一级标题，例如：
  // # SwiftUI @State
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return titleMatch?.[1]?.trim();
}

function extractMarkdownKeywords(content: string): string[] {
  // 匹配 Keywords 行，例如：
  // Keywords: SwiftUI, @State, state
  const keywordsMatch = content.match(/^Keywords:\s*(.+)$/im);
  const keywordsText = keywordsMatch?.[1];

  if (!keywordsText) {
    return [];
  }

  return keywordsText
    // 用逗号拆分多个关键词。
    .split(",")
    // 去掉每个关键词前后的空格。
    .map((keyword) => keyword.trim())
    // 去掉空字符串。
    .filter(Boolean);
}

/**
 * 把文本转成更适合匹配的形式。
 *
 * 这里做的是非常基础的标准化：
 * - 英文统一小写
 * - 多个空白合并
 */
function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 从用户问题中拆出一些用于匹配的词。
 *
 * 这不是自然语言理解，只是轻量关键词检索。
 * 例如：
 * "@State 和 @Binding 有什么区别？"
 * 会提取出 @state、@binding 等关键词。
 */
function tokenizeForSearch(text: string): string[] {
  const normalizedText = normalizeForSearch(text);

  /**
   * 这里用正则提取两类词：
   *
   * 1. 英文/符号词：
   *    @state、@binding、urlsession、node.js
   *
   * 2. 连续中文词：
   *    状态、网络请求、结构化输出
   *
   * 这只是轻量文本搜索，不是完整中文分词。
   */
  const matches =
    normalizedText.match(/[@#]?[a-z0-9_+.-]+|[\u4e00-\u9fff]{2,}/g) || [];

  return Array.from(
    new Set(
      matches
        .map((term) => term.trim())
        // 过滤太短的词，减少无意义匹配。
        .filter((term) => term.length >= 2)
        // 过滤“什么、怎么、how、the”这类停用词。
        .filter((term) => !stopWords.has(term))
    )
  );
}

/**
 * 给一篇文档打相关性分数。
 *
 * 分数越高，说明这篇文档越可能和用户问题相关。
 * 第一版规则很朴素：
 * - 命中 Keywords，加分最多
 * - 命中文档标题，加较多分
 * - 命中文档正文，加少量分
 */
function scoreKnowledgeDocument(
  question: string,
  document: KnowledgeDocument
): number {
  const questionText = normalizeForSearch(question);
  const titleText = normalizeForSearch(document.title);
  const contentText = normalizeForSearch(document.content);
  const keywordTexts = document.keywords.map(normalizeForSearch);
  const queryTerms = tokenizeForSearch(question);

  let score = 0;

  /**
   * 规则 1：用户问题完整命中文档 keyword，给高分。
   *
   * 例如问题里包含 "@State"，文档 Keywords 里也有 "@State"，
   * 这通常说明文档非常相关。
   */
  for (const keyword of keywordTexts) {
    if (keyword && questionText.includes(keyword)) {
      score += 20;
    }
  }

  /**
   * 规则 2：把用户问题拆出来的词逐个匹配文档。
   *
   * title 命中：加较多分，因为标题代表文档主题。
   * keywords 命中：加更多分，因为关键词是人工标注的主题词。
   * content 命中：加少量分，因为正文里偶然出现某个词也可能相关。
   */
  for (const term of queryTerms) {
    if (titleText.includes(term)) {
      score += 12;
    }

    if (keywordTexts.some((keyword) => keyword.includes(term) || term.includes(keyword))) {
      score += 16;
    }

    if (contentText.includes(term)) {
      // @State、@Binding 这类带 @ 的词通常非常具体，所以稍微多加一点分。
      score += term.startsWith("@") ? 6 : 3;
    }
  }

  return score;
}

/**
 * 根据用户问题检索最相关的知识库文档。
 */
function retrieveRelevantKnowledge(question: string): ScoredKnowledgeDocument[] {
  return knowledgeDocuments
    // 先给每篇文档打分。
    .map((document) => ({
      document,
      score: scoreKnowledgeDocument(question, document),
    }))
    // 分数太低说明只是弱相关，不放进 prompt。
    .filter((item) => item.score >= minKnowledgeScore)
    // 按分数从高到低排序。
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      // 分数相同用文件名排序，让结果稳定，方便调试。
      return a.document.fileName.localeCompare(b.document.fileName);
    })
    // 只取前几篇，避免 prompt 太长。
    .slice(0, maxKnowledgeDocuments);
}

function truncateText(text: string, maxLength: number): string {
  // 文档不长时直接返回。
  if (text.length <= maxLength) {
    return text;
  }

  // 文档太长时截断，并加 ... 提醒这是截断内容。
  return `${text.slice(0, maxLength)}\n...`;
}

/**
 * 把检索到的 Markdown 文档整理成 prompt 里的 context。
 *
 * 这里限制字符数，是为了避免 prompt 过长。
 * 以后接入真正的向量检索时，可以改成“文档切片”级别的控制。
 */
function buildKnowledgeContext(matches: ScoredKnowledgeDocument[]): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  let context = "";

  for (const match of matches) {
    /**
     * 每篇资料在 prompt 里都带上：
     * - Source：文件名，方便调试
     * - Title：标题，帮助 AI 理解资料主题
     * - Relevance score：相关性分数，方便我们在日志和 prompt 中排查
     * - 文档正文：真正给 AI 参考的内容
     */
    const nextBlock = `
[Source: ${match.document.fileName}]
[Title: ${match.document.title}]
[Relevance score: ${match.score}]

${truncateText(match.document.content, maxCharactersPerDocument)}
`;

    // 如果继续追加会超过总长度限制，就停止追加。
    if ((context + nextBlock).length > maxKnowledgeContextCharacters) {
      break;
    }

    context += nextBlock;
  }

  return context.trim();
}

//8.3 Tool Calling / Agent：定义工具、校验参数、执行工具
/**
 * 提供给模型看的工具列表。
 *
 * 注意：
 * 这里的 tools 只是“工具说明书”，告诉模型：
 * - 工具叫什么
 * - 什么时候用
 * - 参数长什么样
 *
 * 模型不会真的执行这些函数。
 * 模型只会返回 tool_call，真正执行工具的是后端的 executeAgentTool。
 */
const agentTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "searchKnowledge",
      description:
        "Search the local Markdown knowledge base for iOS, SwiftUI, backend, RAG, streaming, and project concepts. Use this before answering questions that may depend on project docs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A concise search query, for example 'SwiftUI @State' or 'URLSession JSON request'.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generateQuiz",
      description:
        "Generate beginner-friendly practice questions for a learning topic. Use this when the user asks for exercises, quiz questions, practice, review, or wants to test understanding.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The learning topic, for example 'SwiftUI @State' or 'iOS URLSession'.",
          },
          count: {
            type: "integer",
            description:
              "How many questions to generate. Keep it between 1 and 5.",
            minimum: 1,
            maximum: 5,
          },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * 解析模型返回的工具参数。
 *
 * Chat Completions 协议里，tool_call.function.arguments 是字符串，
 * 内容通常是 JSON，例如：
 *
 * {"query":"SwiftUI @State"}
 *
 * 但它毕竟是模型生成的文本，不能假设永远合法。
 * 如果解析失败，这里返回 undefined，让后面的参数校验统一处理错误。
 */
function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments || "{}");
  } catch {
    return undefined;
  }
}

/**
 * 判断 unknown 值是不是普通对象。
 *
 * TypeScript 里 JSON.parse 的结果是 unknown。
 * 在读取 value.query / value.topic 之前，
 * 需要先确认它真的是对象，而不是 null、数组、数字或字符串。
 */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 校验 searchKnowledge 的参数。
 *
 * 模型生成的 tool arguments 不能直接相信：
 * - 可能不是合法 JSON
 * - 可能漏字段
 * - 可能把 query 写成数字或对象
 *
 * 所以每个工具都要在后端做自己的参数校验。
 */
function normalizeSearchKnowledgeArguments(
  rawArguments: unknown
): SearchKnowledgeArguments | undefined {
  if (!isObjectRecord(rawArguments)) {
    return undefined;
  }

  const query = rawArguments.query;

  if (typeof query !== "string") {
    return undefined;
  }

  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return undefined;
  }

  return {
    query: trimmedQuery,
  };
}

/**
 * 校验 generateQuiz 的参数。
 *
 * 这里和 searchKnowledge 一样，不能相信模型传来的 arguments。
 * 后端会做三件事：
 * - topic 必须是非空字符串
 * - count 可以省略
 * - 如果 count 是数字，就四舍五入并限制在 1 到 5
 *
 * 这样即使模型传了 999、0、2.7，也不会让工具输出失控。
 */
function normalizeGenerateQuizArguments(
  rawArguments: unknown
): GenerateQuizArguments | undefined {
  if (!isObjectRecord(rawArguments)) {
    return undefined;
  }

  const topic = rawArguments.topic;

  if (typeof topic !== "string") {
    return undefined;
  }

  const trimmedTopic = topic.trim();

  if (!trimmedTopic) {
    return undefined;
  }

  const countValue = rawArguments.count;
  const count =
    typeof countValue === "number" && Number.isFinite(countValue)
      ? Math.min(Math.max(Math.round(countValue), 1), 5)
      : 3;

  return {
    topic: trimmedTopic,
    count,
  };
}

/**
 * 执行 searchKnowledge 工具。
 *
 * 它复用当前已有的轻量 RAG 检索逻辑：
 * - retrieveRelevantKnowledge：打分并找出相关 Markdown 文档
 * - truncateText：限制返回给模型的内容长度
 *
 * 返回给模型的是结构化 JSON 字符串。
 * 这样模型能清楚看到 source / title / excerpt，而不是一大段难以解析的文本。
 */
function runSearchKnowledgeTool(args: SearchKnowledgeArguments): AgentToolExecutionResult {
  const matches = retrieveRelevantKnowledge(args.query);

  return {
    toolName: "searchKnowledge",
    ok: true,
    result: {
      query: args.query,
      matches: matches.map((match) => ({
        source: match.document.fileName,
        title: match.document.title,
        score: match.score,
        excerpt: truncateText(match.document.content, 1200),
      })),
    },
  };
}

/**
 * 执行 generateQuiz 工具。
 *
 * 第一版先不再嵌套调用模型生成题目，
 * 而是用后端模板生成几个稳定的学习题。
 *
 * 这样有两个好处：
 * - Tool Calling 链路更容易调试
 * - 工具结果可预测，不会因为工具内部又调用模型而增加复杂度和成本
 *
 * 最终题目仍然会交给模型整理成自然语言回答。
 */
function runGenerateQuizTool(args: GenerateQuizArguments): AgentToolExecutionResult {
  const templates = [
    `请用自己的话解释 ${args.topic} 的核心作用。`,
    `请举一个适合使用 ${args.topic} 的具体 iOS 开发场景。`,
    `请说明 ${args.topic} 常见的一个误区，并写出正确理解。`,
    `如果你要把 ${args.topic} 讲给初学者，你会用什么类比？`,
    `请写一个和 ${args.topic} 相关的小代码片段或伪代码思路。`,
  ];

  return {
    toolName: "generateQuiz",
    ok: true,
    result: {
      topic: args.topic,
      count: args.count ?? 3,
      questions: templates.slice(0, args.count ?? 3).map((question, index) => ({
        number: index + 1,
        question,
      })),
    },
  };
}

/**
 * 生成一个统一格式的工具失败结果。
 *
 * 失败结果也会作为 tool message 交回模型。
 * 这样模型可以在最终回答里自然说明：
 * “我尝试调用工具，但参数不合法/工具不存在。”
 */
function buildToolErrorResult(
  toolName: string,
  error: string
): AgentToolExecutionResult {
  return {
    toolName,
    ok: false,
    error,
  };
}

/**
 * 根据模型返回的 tool_call 执行真正的后端工具。
 *
 * 这是 Tool Calling 最关键的安全边界：
 * - 模型只能“请求调用工具”
 * - 后端决定这个工具是否存在
 * - 后端校验参数是否合法
 * - 后端执行真实函数
 *
 * 后续如果接订单、支付、工单等业务系统，
 * 权限校验、用户确认、审计日志也都应该放在这个边界附近。
 */
function executeAgentTool(toolCall: ChatCompletionMessageToolCall): AgentToolExecutionResult {
  if (toolCall.type !== "function") {
    return buildToolErrorResult("unknown", "Only function tool calls are supported.");
  }

  const toolName = toolCall.function.name as AgentToolName;
  const rawArguments = parseToolArguments(toolCall.function.arguments);

  switch (toolName) {
    case "searchKnowledge": {
      const args = normalizeSearchKnowledgeArguments(rawArguments);

      if (!args) {
        return buildToolErrorResult(toolName, "Invalid arguments. Expected { query: string }.");
      }

      return runSearchKnowledgeTool(args);
    }

    case "generateQuiz": {
      const args = normalizeGenerateQuizArguments(rawArguments);

      if (!args) {
        return buildToolErrorResult(
          toolName,
          "Invalid arguments. Expected { topic: string, count?: number }."
        );
      }

      return runGenerateQuizTool(args);
    }

    default:
      return buildToolErrorResult(
        toolCall.function.name,
        `Unknown tool: ${toolCall.function.name}`
      );
  }
}

/**
 * 把工具结果转成 tool message 的 content。
 *
 * Chat Completions 的 tool 消息 content 需要是字符串，
 * 所以后端把统一结果对象 JSON.stringify 后再放回 messages。
 */
function stringifyToolResult(result: AgentToolExecutionResult): string {
  return JSON.stringify(result);
}

/**
 * Agent 最多允许连续调用几轮工具。
 *
 * 为什么需要上限？
 * 模型可能因为提示词、工具结果、或边界问题陷入循环：
 * - 一直调用 searchKnowledge
 * - 搜不到资料后反复换 query
 * - 生成题目后又继续生成题目
 *
 * 设置上限后，后端可以保证一次请求最终会停止。
 */
const maxAgentToolSteps = 4;

type AgentRunResult = {
  /**
   * 工具调用阶段结束后的完整 messages。
   *
   * 里面包含：
   * - system prompt
   * - 历史对话
   * - 当前用户问题
   * - assistant 发起的 tool_calls
   * - 后端返回的 tool 结果
   *
   * 最终流式回答会继续使用这份 messages。
   */
  messages: ChatCompletionMessageParam[];

  /**
   * 本次请求实际执行了多少个工具调用。
   *
   * 这个值主要用于日志，方便开发时确认：
   * 用户的问题到底有没有触发 Tool Calling。
   */
  toolCallCount: number;
};

/**
 * 组装 Agent 初始 messages。
 *
 * 和普通 RAG 接口不同：
 * - 普通接口会先检索知识库，再把资料塞进 system prompt
 * - Agent 接口只告诉模型有哪些工具可用，让模型自己决定是否 searchKnowledge
 *
 * 这种写法更接近真实 Agent：
 * 模型先读问题和历史，再选择要不要使用工具。
 */
function buildAgentMessages(
  message: string,
  systemPrompt: string | undefined,
  history: NormalizedChatHistoryItem[]
): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: buildAgentInstructions(systemPrompt),
    },
    ...history.map((item): ChatCompletionMessageParam => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user",
      content: message,
    },
  ];
}

/**
 * 把模型返回的 assistant tool_call 消息整理成下一轮请求可用的 message。
 *
 * 不能只保留 content 和 tool_calls。
 *
 * DeepSeek V4 thinking mode 默认开启；当 assistant 消息里包含 tool_calls 时，
 * DeepSeek 会同时返回 reasoning_content。
 * 下一轮把 tool 结果发回模型时，必须把 reasoning_content 一起带上，
 * 否则 DeepSeek 会返回：
 * The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * OpenAI SDK 类型里没有 reasoning_content，
 * 所以这里用本地扩展类型保留这个 DeepSeek 专有字段。
 */
function buildAssistantToolMessage(
  assistantMessage: DeepSeekAssistantMessageWithReasoning,
  toolCalls: ChatCompletionMessageToolCall[]
): ChatCompletionAssistantMessageParam {
  const assistantToolMessage: DeepSeekAssistantMessageWithReasoning = {
    role: "assistant",
    content: assistantMessage.content ?? null,
    tool_calls: toolCalls,
  };

  if (typeof assistantMessage.reasoning_content === "string") {
    assistantToolMessage.reasoning_content = assistantMessage.reasoning_content;
  }

  return assistantToolMessage;
}

/**
 * 执行 Agent 的“工具调用阶段”。
 *
 * 第一版采用一个更容易理解和维护的两阶段设计：
 *
 * 阶段 1：非流式 tool calling
 * - 模型决定是否调用工具
 * - 后端执行工具
 * - 工具结果放回 messages
 * - 最多循环 maxAgentToolSteps 次
 *
 * 阶段 2：流式最终回答
 * - 工具调用阶段结束后
 * - 再用 stream: true 生成最终回复给 iOS
 *
 * 为什么不一开始就做“流式 tool calling”？
 * 流式 tool calling 需要拼接 delta 里的工具名和 arguments，
 * 边界更多，也更难给初学项目讲清楚。
 * 先用非流式工具阶段，可以把 Agent 核心流程跑通。
 */
async function runAgentToolLoop(
  message: string,
  systemPrompt: string | undefined,
  history: NormalizedChatHistoryItem[]
): Promise<AgentRunResult> {
  const messages = buildAgentMessages(message, systemPrompt, history);
  let toolCallCount = 0;

  for (let step = 0; step < maxAgentToolSteps; step += 1) {
    const completion = await deepseek.chat.completions.create({
      model,
      messages,
      tools: agentTools,
      tool_choice: "auto",
    });

    const assistantMessage = completion.choices[0]
      ?.message as DeepSeekAssistantMessageWithReasoning | undefined;

    if (!assistantMessage) {
      break;
    }

    const toolCalls = assistantMessage.tool_calls || [];

    /**
     * 没有 tool_calls，说明模型认为不需要工具，
     * 或者工具调用阶段已经结束，可以进入最终回答阶段。
     */
    if (toolCalls.length === 0) {
      break;
    }

    toolCallCount += toolCalls.length;

    /**
     * 必须把 assistant 的 tool_calls 原样放回 messages。
     *
     * Chat Completions 协议要求：
     * assistant(tool_calls)
     * -> tool(result)
     * -> assistant/final
     *
     * 如果只放 tool 结果，不放 assistant 的 tool_calls，
     * 下一轮模型就不知道这些 tool 结果是在回应哪一次调用。
     */
    messages.push(buildAssistantToolMessage(assistantMessage, toolCalls));

    for (const toolCall of toolCalls) {
      const toolResult = executeAgentTool(toolCall);

      console.log(
        `[Agent] tool call: ${toolCall.type === "function" ? toolCall.function.name : toolCall.type}, ok: ${toolResult.ok}`
      );

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: stringifyToolResult(toolResult),
      });
    }
  }

  return {
    messages,
    toolCallCount,
  };
}

/**
 * 组装一次 Chat Completions 请求需要的全部上下文。
 *
 * 为什么要把这段逻辑抽出来？
 * /api/chat 和 /api/chat/stream 的共同部分很多：
 * - 根据“当前问题 + 历史”做 RAG 检索
 * - 把知识库命中结果拼成 system prompt
 * - 把 system、历史消息、当前用户问题组装成 messages
 *
 * 如果两边各写一份，后续维护时很容易出现：
 * - 普通接口带 history，流式接口忘了带 history
 * - 普通接口做 RAG，流式接口忘了做 RAG
 * - 两边 system prompt 逻辑不一致
 *
 * 所以这里用 responseMode 控制“输出格式”，其余上下文逻辑保持一致。
 */
function prepareChatCompletion(
  message: string,
  systemPrompt: string | undefined,
  history: NormalizedChatHistoryItem[],
  responseMode: ChatResponseMode
): PreparedChatCompletion {
  /**
   * RAG 检索使用“历史 + 当前问题”。
   *
   * 这样用户追问“继续”“举个例子”时，
   * 检索仍然能看到上一轮里的 @State、URLSession 等关键词。
   */
  const retrievalQuery = buildRetrievalQuery(message, history);
  const knowledgeMatches = retrieveRelevantKnowledge(retrievalQuery);

  /**
   * 把命中的 Markdown 文档整理成一段 prompt context。
   * 没有命中时返回 undefined，buildRagGuide 会明确告诉 AI 使用通用知识。
   */
  const knowledgeContext = buildKnowledgeContext(knowledgeMatches);

  /**
   * 两种接口只在输出格式上不同：
   * - structured：强制 JSON
   * - streaming：普通文本，方便边生成边展示
   */
  const instructions =
    responseMode === "streaming"
      ? buildStreamingInstructions(systemPrompt, knowledgeContext)
      : buildInstructions(systemPrompt, knowledgeContext);

  /**
   * Chat Completions messages 的顺序很重要：
   * 1. system：角色、RAG、输出格式规则
   * 2. history：最近几轮用户和 AI 的真实对话
   * 3. user：这一次的新问题
   *
   * 当前问题不要放进 history，因为它已经作为最后一条 user message 单独发送。
   */
  const aiMessages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: instructions,
    },
    ...history.map((item): ChatCompletionMessageParam => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user",
      content: message,
    },
  ];

  return {
    knowledgeMatches,
    aiMessages,
  };
}

/**
 * 打印本次请求的 RAG 和 history 信息。
 *
 * 普通接口和流式接口都会调用它，方便在终端对比：
 * - 哪些知识库文档被命中
 * - 发给模型的历史消息数量
 */
function logChatContext(
  responseMode: ChatResponseMode,
  knowledgeMatches: ScoredKnowledgeDocument[],
  history: NormalizedChatHistoryItem[]
): void {
  console.log(
    `[RAG:${responseMode}] matched documents: ${
      knowledgeMatches
        .map((item) => `${item.document.fileName}:${item.score}`)
        .join(", ") || "none"
    }`
  );
  console.log(`[History:${responseMode}] messages sent to AI: ${history.length}`);
}

/**
 * 向 iOS 写一条 SSE 事件。
 *
 * SSE 的基本格式是：
 *
 * data: {"type":"delta","delta":"hello"}
 *
 * 注意最后必须有一个空行，也就是 \n\n。
 * 浏览器、URLSession 或其他客户端会用这个空行判断“一条事件结束了”。
 */
function writeSseEvent(res: Response, event: ChatStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * 服务启动时读取一次知识库。
 *
 * 当前适合学习和小型 Demo。
 * 如果以后知识库会频繁更新，可以改成：
 * - 每次请求重新读取
 * - 或者增加一个刷新知识库的接口
 */
const knowledgeDocuments = loadKnowledgeDocuments();

console.log(
  `Loaded ${knowledgeDocuments.length} knowledge documents from ${knowledgeDirectory}`
);


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
      //核心代码
      /**
       * DeepSeek 使用 OpenAI-compatible 的 Chat Completions API。
       * model：用哪个模型
       * messages：聊天上下文，system 是系统提示词，user 是用户输入
       */
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

//11. 流式聊天接口
/**
 这个接口是 /api/chat 的第一版流式版本。

 它仍然复用：
 - message：当前用户问题
 - system_prompt：角色设定
 - history：最近聊天上下文
 - RAG：知识库检索结果

 但返回方式不同：
 - /api/chat 等模型完整返回后，再把 JSON 一次性返回给 iOS
 - /api/chat/stream 会把模型生成的文本片段一段段转发给 iOS

 第一版流式接口只返回普通文本，不返回结构化 JSON。
 这样 iOS 可以直接把 delta 追加到同一条 AI 气泡里，
 用户不会看到半截 JSON。
 */
app.post(
  "/api/chat/stream",
  async (
    req: Request,
    res: Response<ErrorResponseBody>
  ) => {
    let clientClosed = false;

    /**
     * 如果 iOS 用户离开页面、网络断开、或者请求被取消，
     * Express 会触发 close。
     *
     * 这里记录 clientClosed，后面 for await 读取模型流时会尽快停止写入，
     * 避免继续往一个已经关闭的连接里 res.write。
     */
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

      /**
       * SSE 必须设置 text/event-stream。
       *
       * Cache-Control:
       * - no-cache：告诉中间层不要缓存这条响应
       * - no-transform：避免代理层压缩/改写流式内容
       *
       * Connection: keep-alive：
       * - 告诉客户端这条 HTTP 连接会保持一段时间，用来持续接收事件
       */
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      /**
       * 立即把响应头发给 iOS。
       *
       * 如果不 flushHeaders，有些客户端会等到第一段 body 出现才认为连接建立。
       * 对流式输出来说，越早让客户端知道“连接成功”，体验越好。
       */
      res.flushHeaders();

      /**
       * 开启 DeepSeek / OpenAI-compatible 的流式返回。
       *
       * stream: true 之后，completion 不再是一个完整对象，
       * 而是一个 async iterable。我们可以用 for await 一段段读取。
       */
      const stream = await deepseek.chat.completions.create({
        model,
        messages: aiMessages,
        stream: true,
      });

      for await (const chunk of stream) {
        if (clientClosed) {
          break;
        }

        /**
         * Chat Completions 的流式 chunk 通常长这样：
         * {
         *   choices: [
         *     {
         *       delta: { content: "一小段文本" }
         *     }
         *   ]
         * }
         *
         * 有些 chunk 只表示 role、结束原因等元信息，没有 content。
         * 这类 chunk 不需要发给 iOS。
         */
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

      /**
       * 如果错误发生在 SSE 响应头发送之前，
       * 仍然可以像普通 JSON 接口一样返回 500。
       *
       * 如果错误发生在流式连接建立之后，
       * HTTP 状态码已经不能改了，只能通过 SSE error 事件告诉 iOS。
       */
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

//12. Agent 流式接口：Tool Calling + 最终流式回答
/**
 这个接口是第一版 iOS 学习助手 Agent。

 和 /api/chat/stream 的区别：
 - /api/chat/stream：后端固定做 RAG，然后模型直接回答
 - /api/agent/stream：模型可以先选择工具，后端执行工具，再让模型最终回答

 第一版支持两个本地工具：
 - searchKnowledge(query)：搜索本地 Markdown 知识库
 - generateQuiz(topic, count)：生成学习练习题

 重要边界：
 模型不会真正执行工具。
 模型只会返回 tool_call。
 后端校验工具名和参数后，才会执行真正的函数。
 */
app.post(
  "/api/agent/stream",
  async (
    req: Request,
    res: Response<ErrorResponseBody>
  ) => {
    let clientClosed = false;

    /**
     * Agent 接口也要监听客户端断开。
     *
     * 因为 Tool Calling 阶段可能需要先等一次或多次模型响应，
     * 如果用户中途离开页面或网络断开，后端应该尽快停止后续写入。
     */
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

      /**
       * 先建立 SSE 连接。
       *
       * Agent 工具调用阶段本身是非流式的，可能需要一点时间。
       * 提前 flush headers 后，iOS 能尽早知道连接成功，
       * 页面可以进入“AI 正在回复”的状态。
       */
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      console.log(`[Agent] history messages sent to AI: ${history.length}`);

      /**
       * 第一阶段：Agent Tool Calling 循环。
       *
       * 这里模型可以：
       * - 直接不调用工具，进入最终回答
       * - 调用 searchKnowledge
       * - 调用 generateQuiz
       * - 在拿到工具结果后继续调用下一个工具
       *
       * 后端会限制最多 maxAgentToolSteps 轮，防止无限循环。
       */
      const agentRun = await runAgentToolLoop(message, systemPrompt, history);

      console.log(`[Agent] tool calls executed: ${agentRun.toolCallCount}`);

      if (clientClosed) {
        res.end();
        return;
      }

      /**
       * 第二阶段：最终回答流式输出。
       *
       * 注意这里不再传 tools / tool_choice。
       *
       * 原因：
       * - 工具调用阶段已经结束
       * - 最终阶段只需要基于 agentRun.messages 里的工具结果生成回答
       * - 不传 tools 时，模型没有可调用工具，自然只能输出文本
       *
       * 这样也更兼容不同 OpenAI-compatible 服务，
       * 避免某些服务对 tool_choice: "none" 或 tools + stream 的支持不一致。
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

        /**
         * 最终阶段没有再传 tools，
         * 所以这里和普通流式接口一样，只关心 delta.content。
         *
         * 工具结果已经在 agentRun.messages 里，
         * 模型会基于这些消息生成最终自然语言回答。
         */
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
