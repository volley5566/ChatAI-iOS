
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
  const rolePrompt =
    systemPrompt ||
    "You are a helpful AI assistant. Explain concepts clearly and simply for a mobile developer learning iOS, SwiftUI, and AI application development.";

  /**
   * ragGuide 是 RAG 阶段额外加入的提示词。
   *
   * 如果检索到了知识库资料：
   * - 告诉 AI 优先参考这些资料
   * - 再让 AI 回答用户问题
   *
   * 如果没有检索到资料：
   * - 明确告诉 AI 没有匹配资料
   * - 让 AI 使用通用知识回答
   *
   * 这样做的好处是：
   * AI 不会误以为每次都有知识库资料，也更容易遵守我们的回答边界。
   */
  const ragGuide = knowledgeContext
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

      if (!message) {
        res.status(400).json({
          error: "Message cannot be empty.",
        });
        return;
      }

      /**
       * RAG 第一步：根据用户问题检索知识库。
       *
       * 例如用户问 "@State 和 @Binding 有什么区别？"
       * 这里通常会命中：
       * - swiftui-state.md
       * - swiftui-binding.md
       */
      const knowledgeMatches = retrieveRelevantKnowledge(message);

      /**
       * RAG 第二步：把命中的文档整理成一段知识库上下文。
       *
       * 这段内容不会直接返回给 iOS，
       * 而是放进 prompt，作为 AI 回答时的参考资料。
       */
      const knowledgeContext = buildKnowledgeContext(knowledgeMatches);

      /**
       * RAG 第三步：把角色设定、知识库上下文、结构化输出规则组合成 system prompt。
       */
      const instructions = buildInstructions(systemPrompt, knowledgeContext);

      // 打印命中的文档，方便你在终端确认 RAG 有没有生效。
      console.log(
        `[RAG] matched documents: ${
          knowledgeMatches
            .map((item) => `${item.document.fileName}:${item.score}`)
            .join(", ") || "none"
        }`
      );
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
