import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { retrieveRelevantKnowledge, truncateText } from "../knowledge/knowledge";
import {
  buildToolErrorResult,
  isObjectRecord,
  type AgentToolExecutionResult,
} from "../agent/agentToolTypes";
import { invokeLangChainChat } from "../langchain/chatModel";
import { loadKnowledgeDocuments } from "../langchain/documentLoader";

export type SearchKnowledgeArguments = {
  query: string;
};

export type GenerateQuizArguments = {
  topic: string;
  count?: number;
};

/**
 * ═══════════════════════════════════════════════════════════════════
 * mcp/mcpToolHandlers.ts — 真实工具逻辑(不关心 transport / SSE / HTTP)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   mcpServer.ts 注册工具时调这里的 runXxxTool 函数。
 *
 * # 设计原则:工具逻辑和协议解耦
 *   不关心:HTTP / SSE / DeepSeek tools 格式 / MCP transport
 *   只关心:已经校验过的参数 → 工具结果
 *
 * # 工具分两类:
 *   - 纯本地(searchKnowledge)       → 直接调 RAG retriever
 *   - LLM-as-tool(其余 3 个)        → 工具内部再发一次 DeepSeek 请求
 *     · generateQuiz       → LLM 出题(失败 fallback 到模板)
 *     · evaluateAnswer     → LLM-as-judge 批改
 *     · recommendNextTopic → LLM 规划下一步学习方向
 */

/**
 * evaluateAnswer 接收的参数。
 *
 * - question:     正在评判的题目原文(必填)
 * - userAnswer:   用户的回答(必填)
 * - topic:        可选,知识领域上下文(例如 "SwiftUI @State"),给评分模型一个范围提示
 * - expectedConcepts: 可选,出题方期望覆盖的要点数组。
 *                 generateQuiz 升级后会自然传入,让批改更精准——否则模型自己估。
 */
export type EvaluateAnswerArguments = {
  question: string;
  userAnswer: string;
  topic?: string;
  expectedConcepts?: string[];
};

/**
 * recommendNextTopic 的参数。
 *
 * - recentTopics:    用户最近讨论 / 已经学过的主题列表。
 *                    Agent 从最近对话历史里提取后传入(显式传参,不让推荐工具
 *                    去翻 thread state——保持工具是"纯输入纯输出")。
 * - focusArea:       可选,用户想专注的方向,例如 "SwiftUI" 或 "LangGraph"。
 *                    没传就让推荐工具从 recentTopics 自己推断。
 * - count:           想要几个建议,默认 3,上限 5。
 */
export type RecommendNextTopicArguments = {
  recentTopics: string[];
  focusArea?: string;
  count: number;
};

export function normalizeSearchKnowledgeArguments(
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

  return { query: trimmedQuery };
}

export function normalizeGenerateQuizArguments(
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

export async function runSearchKnowledgeTool(
  args: SearchKnowledgeArguments
): Promise<AgentToolExecutionResult> {
  /**
   * 当前 RAG 已经由 LangChain 接管：
   * Markdown loader -> splitter -> embeddings -> MemoryVectorStore -> similarity search。
   *
   * 这里返回的是结构化结果，而不是直接拼 prompt：
   * - MCP client 可以稳定读取 matches 数量
   * - Agent Runner 可以把完整 chunk 结果交回模型
   * - 模型最终回答时可以用 citation 告诉用户参考来源
   * - iOS 可以通过 tool_done 展示“找到 N 条相关资料”
   *
   * 注意：这里暂时不直接把 sources 推给 iOS。
   * 当前版本先让模型在最终回答里自然展示来源；
   * 后续如果要做独立“参考来源 UI”，可以新增 SSE event 或最终 metadata。
   */
  const matches = await retrieveRelevantKnowledge(args.query);

  return {
    toolName: "searchKnowledge",
    ok: true,
    result: {
      query: args.query,
      matches: matches.map((match) => ({
        source: match.chunk.fileName,
        title: match.chunk.title,
        section: match.chunk.section,
        citation: match.chunk.citation,
        score: match.score,
        excerpt: truncateText(match.chunk.content, 1200),
      })),
    },
  };
}

/**
 * generateQuiz 用 LLM 真生成。
 *
 * 早期版本是固定 5 个模板套 topic,题目和 topic 可能没啥关系
 * (比如 "请把 RAG 讲给初学者")。LLM 生成的题目能针对具体概念出题,
 * 还能附带 expectedConcepts——为 evaluateAnswer 的精准批改铺路。
 *
 * 失败兜底:LLM 调用失败时退回到模板版本,保证 generateQuiz **总能给出可用结果**——
 * 这是 "graceful degradation"(优雅降级)模式。
 */
const generateQuizSystemPrompt = `
You are an iOS / Swift / AI app development tutor. You design practice questions for a learning topic.

Output ONLY valid JSON. No Markdown. No code fences. No surrounding text.

JSON shape (use exactly these keys):
{
  "questions": [
    {
      "number": 1,
      "question": "...",
      "expectedConcepts": ["...", "..."],
      "difficulty": "入门" | "中级" | "进阶"
    }
  ]
}

Rules:
- Generate the EXACT number of questions requested.
- Each question should test understanding, not rote recall.
- Be specific about the topic. Vague questions like "请讲讲 X" are not allowed.
- Mix difficulty levels: if count >= 2, include at least one 入门 and one 中级 or 进阶.
- expectedConcepts: 2-4 short keywords/phrases the ideal answer should cover. These are NOT shown to the student — they feed evaluateAnswer tool.
- Write questions in the same language as the topic. If topic is Chinese, questions are Chinese.
- Each question should fit in 1-2 sentences.
- Never include the answers — only the questions and their expectedConcepts (for grading).
`.trim();

type RawQuizQuestion = {
  number?: unknown;
  question?: unknown;
  expectedConcepts?: unknown;
  difficulty?: unknown;
};

type RawQuizOutput = {
  questions?: unknown;
};

type GeneratedQuestion = {
  number: number;
  question: string;
  expectedConcepts: string[];
  difficulty: "入门" | "中级" | "进阶";
};

function normalizeQuizOutput(
  rawText: string,
  expectedCount: number
): GeneratedQuestion[] {
  const jsonText = extractJsonFromLlmOutput(rawText);

  if (!jsonText) {
    throw new Error("Quiz model did not return JSON.");
  }

  const parsed = JSON.parse(jsonText) as RawQuizOutput;

  if (!Array.isArray(parsed.questions)) {
    throw new Error("Quiz output missing 'questions' array.");
  }

  const validDifficulties = new Set(["入门", "中级", "进阶"]);

  const questions = parsed.questions
    .filter(isObjectRecord)
    .map((item, index): GeneratedQuestion | undefined => {
      const raw = item as RawQuizQuestion;

      if (typeof raw.question !== "string" || !raw.question.trim()) {
        return undefined;
      }

      /**
       * number 字段允许模型出错——直接用数组下标重排,
       * 保证返回结果一定是 1..N 连续编号。
       */
      const number = index + 1;

      const expectedConcepts = Array.isArray(raw.expectedConcepts)
        ? raw.expectedConcepts
            .filter((concept): concept is string => typeof concept === "string")
            .map((concept) => concept.trim())
            .filter(Boolean)
            .slice(0, 4)
        : [];

      const difficultyRaw =
        typeof raw.difficulty === "string" ? raw.difficulty.trim() : "中级";
      const difficulty = (
        validDifficulties.has(difficultyRaw) ? difficultyRaw : "中级"
      ) as "入门" | "中级" | "进阶";

      return {
        number,
        question: raw.question.trim(),
        expectedConcepts,
        difficulty,
      };
    })
    .filter(
      (item): item is GeneratedQuestion => item !== undefined
    )
    .slice(0, expectedCount);

  if (questions.length === 0) {
    throw new Error("Quiz output had no valid questions.");
  }

  return questions;
}

/**
 * 兜底模板版本——LLM 调用失败时使用。
 *
 * 保留 expectedConcepts 字段(即使是空数组),让上下游 schema 始终一致。
 * 这就是设计 graceful degradation 时要注意的点:fallback 输出必须和正常输出
 * 长得一样,只是质量降低,而不是结构变化。否则上游解析逻辑要写两份。
 */
function buildFallbackQuizQuestions(
  topic: string,
  count: number
): GeneratedQuestion[] {
  const templates: Array<{
    question: string;
    difficulty: "入门" | "中级" | "进阶";
  }> = [
    {
      question: `请用自己的话解释 ${topic} 的核心作用。`,
      difficulty: "入门",
    },
    {
      question: `请举一个适合使用 ${topic} 的具体 iOS 开发场景。`,
      difficulty: "中级",
    },
    {
      question: `请说明 ${topic} 常见的一个误区,并写出正确理解。`,
      difficulty: "中级",
    },
    {
      question: `如果你要把 ${topic} 讲给初学者,你会用什么类比?`,
      difficulty: "入门",
    },
    {
      question: `请写一个和 ${topic} 相关的小代码片段或伪代码思路。`,
      difficulty: "进阶",
    },
  ];

  return templates.slice(0, count).map((template, index) => ({
    number: index + 1,
    question: template.question,
    /**
     * 模板版没有针对性,expectedConcepts 留空。
     * evaluateAnswer 收到空数组时会自行从 question 推断要点。
     */
    expectedConcepts: [],
    difficulty: template.difficulty,
  }));
}

export async function runGenerateQuizTool(
  args: GenerateQuizArguments
): Promise<AgentToolExecutionResult> {
  const count = args.count ?? 3;

  /**
   * 先尝试 LLM 真生成,失败再退回模板。
   * try/catch 范围只覆盖"会触发降级"的部分(LLM 调用 + JSON 解析),
   * 不把无关错误吞掉。
   */
  try {
    const userPrompt = `Topic: ${args.topic}\nNumber of questions: ${count}`;

    const rawText = await invokeLangChainChat([
      new SystemMessage(generateQuizSystemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const questions = normalizeQuizOutput(rawText, count);

    return {
      toolName: "generateQuiz",
      ok: true,
      result: {
        topic: args.topic,
        count: questions.length,
        questions,
        /**
         * source 字段是给调试用的,iOS 不展示。
         * 看日志就能知道这一次到底走的 LLM 还是 fallback。
         */
        source: "llm",
      },
    };
  } catch (error) {
    console.warn(
      "[generateQuiz] LLM generation failed, falling back to templates:",
      error
    );

    return {
      toolName: "generateQuiz",
      ok: true,
      result: {
        topic: args.topic,
        count,
        questions: buildFallbackQuizQuestions(args.topic, count),
        source: "template-fallback",
      },
    };
  }
}

export function normalizeEvaluateAnswerArguments(
  rawArguments: unknown
): EvaluateAnswerArguments | undefined {
  if (!isObjectRecord(rawArguments)) {
    return undefined;
  }

  const question = rawArguments.question;
  const userAnswer = rawArguments.userAnswer;

  if (typeof question !== "string" || typeof userAnswer !== "string") {
    return undefined;
  }

  const trimmedQuestion = question.trim();
  const trimmedAnswer = userAnswer.trim();

  if (!trimmedQuestion || !trimmedAnswer) {
    return undefined;
  }

  /**
   * topic 是可选的轻量上下文。
   * 不传也能工作——评分模型从 question 自己推断主题。
   */
  const topicValue = rawArguments.topic;
  const topic =
    typeof topicValue === "string" && topicValue.trim()
      ? topicValue.trim()
      : undefined;

  /**
   * expectedConcepts 也是可选——批改时如果有"出题方期望覆盖的要点",
   * 模型评分会更精准(generateQuiz 升级后会自然传入)。
   * 这里做防御性过滤:非字符串元素丢弃,空数组当 undefined。
   */
  const expectedConceptsRaw = rawArguments.expectedConcepts;
  const expectedConcepts = Array.isArray(expectedConceptsRaw)
    ? expectedConceptsRaw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6)
    : undefined;

  return {
    question: trimmedQuestion,
    userAnswer: trimmedAnswer,
    topic,
    expectedConcepts:
      expectedConcepts && expectedConcepts.length > 0 ? expectedConcepts : undefined,
  };
}

/**
 * LLM-as-judge 评分提示词。
 *
 * 设计要点:
 * 1. 角色明确——"你是一位 iOS 教学老师",把模型锚定到教学语境,
 *    而不是默认的"AI 助手"语气。
 * 2. rubric 显式——4 档分数 + 每档的语义描述,让评分稳定。
 * 3. JSON-only 严格输出——和项目原有结构化接口同款约束,
 *    便于上层用 extractJsonText 解析。
 * 4. 字段顺序固定——strengths 放在 weaknesses 前面,
 *    评判时先看亮点再看不足,语气更建设性。
 */
const evaluateAnswerSystemPrompt = `
You are an iOS / Swift / mobile development tutor. You grade a student's answer.

Output ONLY valid JSON. No Markdown. No code fences. No surrounding text.

JSON shape (use exactly these keys, in this order):
{
  "score": 0 | 1 | 2 | 3,
  "scoreLabel": "需要加油" | "及格" | "良好" | "优秀",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "suggestedAnswer": "..."
}

Scoring rubric:
- 3 / 优秀: covers all key concepts, accurate, uses correct terminology, mentions edge cases or trade-offs.
- 2 / 良好: covers main concept correctly with minor gaps or imprecise terms.
- 1 / 及格: partially correct but misses important concepts or contains a notable misunderstanding.
- 0 / 需要加油: largely incorrect, off-topic, or empty.

Rules:
- Write strengths / weaknesses in the same language as the user's answer.
- strengths: 1-3 short bullets (each under 40 chars).
- weaknesses: 0-3 short bullets, empty array if no obvious gap.
- suggestedAnswer: 1-3 sentences, beginner-friendly, written in the user's language.
- Be fair and constructive. Encourage learning.
- Never include the rubric or your reasoning in the output — only the JSON.
`.trim();

/**
 * 从 LLM 返回文本中提取首尾 {} 之间的 JSON。
 *
 * 模型偶尔会包 \`\`\`json ... \`\`\` 或前后多写几个字。
 * 这里和 structuredAnswer.ts 的 extractJsonText 是同一思路。
 * 没复用是因为这是不同领域的工具,各自的失败兜底语义不同,
 * 抽公共反而要写参数。后续如果再加第 3 处 JSON 解析,可以统一抽。
 */
function extractJsonFromLlmOutput(rawText: string): string | undefined {
  const startIndex = rawText.indexOf("{");
  const endIndex = rawText.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }

  return rawText.slice(startIndex, endIndex + 1);
}

type RawEvaluation = {
  score?: unknown;
  scoreLabel?: unknown;
  strengths?: unknown;
  weaknesses?: unknown;
  suggestedAnswer?: unknown;
};

function normalizeEvaluationOutput(rawText: string): {
  score: 0 | 1 | 2 | 3;
  scoreLabel: string;
  strengths: string[];
  weaknesses: string[];
  suggestedAnswer: string;
} {
  const jsonText = extractJsonFromLlmOutput(rawText);

  if (!jsonText) {
    throw new Error("Evaluation model did not return JSON.");
  }

  const parsed = JSON.parse(jsonText) as RawEvaluation;

  /**
   * 防御性 normalize:模型偶尔会返回 "2" 这种字符串,或者把分数写到 99。
   * 这里夹紧到 0-3,保证下游 iOS 不需要再做 fallback。
   */
  const rawScore =
    typeof parsed.score === "number"
      ? parsed.score
      : Number(parsed.score);
  const safeScore = Number.isFinite(rawScore)
    ? Math.min(Math.max(Math.round(rawScore), 0), 3)
    : 0;
  const score = safeScore as 0 | 1 | 2 | 3;

  const labelFallback = ["需要加油", "及格", "良好", "优秀"][score];
  const scoreLabel =
    typeof parsed.scoreLabel === "string" && parsed.scoreLabel.trim()
      ? parsed.scoreLabel.trim()
      : labelFallback;

  const toStringArray = (value: unknown, maxItems: number): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, maxItems);
  };

  return {
    score,
    scoreLabel,
    strengths: toStringArray(parsed.strengths, 3),
    weaknesses: toStringArray(parsed.weaknesses, 3),
    suggestedAnswer:
      typeof parsed.suggestedAnswer === "string"
        ? parsed.suggestedAnswer.trim()
        : "",
  };
}

export async function runEvaluateAnswerTool(
  args: EvaluateAnswerArguments
): Promise<AgentToolExecutionResult> {
  /**
   * LLM-as-judge 模式:
   * 工具不再是纯函数,而是工具内部再发一次 DeepSeek 请求,让模型自己评分。
   *
   * 设计要点:
   * - system prompt 严格固定 rubric 和输出格式
   * - user 部分组装上下文(题目、用户答案、可选的 topic 和要点)
   * - 解析 JSON 时做防御性 normalize,失败兜底也要给出可用结果
   *
   * 不直接复用外层 agent 的 chat model 实例,而是新建一个——
   * 原因是这个调用要求 streaming=false(评分需要拿到完整 JSON),
   * 而 Agent 主流程通常开 streaming。
   */
  const contextParts: string[] = [];

  if (args.topic) {
    contextParts.push(`Topic: ${args.topic}`);
  }

  if (args.expectedConcepts && args.expectedConcepts.length > 0) {
    contextParts.push(
      `Expected concepts to mention: ${args.expectedConcepts.join(", ")}`
    );
  }

  contextParts.push(`Question:\n${args.question}`);
  contextParts.push(`Student answer:\n${args.userAnswer}`);

  const userPrompt = contextParts.join("\n\n");

  let rawText: string;

  try {
    rawText = await invokeLangChainChat([
      new SystemMessage(evaluateAnswerSystemPrompt),
      new HumanMessage(userPrompt),
    ]);
  } catch (error) {
    return buildToolErrorResult(
      "evaluateAnswer",
      `Evaluation model call failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    const evaluation = normalizeEvaluationOutput(rawText);

    return {
      toolName: "evaluateAnswer",
      ok: true,
      result: {
        question: args.question,
        topic: args.topic,
        ...evaluation,
      },
    };
  } catch (error) {
    /**
     * 模型偶尔会把 JSON 写坏(尤其是 suggestedAnswer 里夹带未转义引号)。
     * 不直接抛错——给前端一个降级结果,让对话还能继续。
     *
     * 这里把 raw text 截短塞到 suggestedAnswer 里,至少用户能看到模型说了什么。
     */
    return {
      toolName: "evaluateAnswer",
      ok: true,
      result: {
        question: args.question,
        topic: args.topic,
        score: 1,
        scoreLabel: "及格",
        strengths: [],
        weaknesses: ["评分模型输出格式异常,以下内容为原始回答"],
        suggestedAnswer: truncateText(rawText, 600),
        parseError:
          error instanceof Error ? error.message : "Unknown parse error",
      },
    };
  }
}

export function normalizeRecommendNextTopicArguments(
  rawArguments: unknown
): RecommendNextTopicArguments | undefined {
  if (!isObjectRecord(rawArguments)) {
    return undefined;
  }

  /**
   * recentTopics 是必填——没有这个,推荐就退化成"瞎猜"。
   * 但允许空数组(用户刚开始学,什么都还没碰过)——这种场景推荐会给入门主题。
   */
  const recentTopicsRaw = rawArguments.recentTopics;

  if (!Array.isArray(recentTopicsRaw)) {
    return undefined;
  }

  const recentTopics = recentTopicsRaw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20); // 防御性上限:就算 Agent 传 100 个,也只取前 20 个

  const focusAreaValue = rawArguments.focusArea;
  const focusArea =
    typeof focusAreaValue === "string" && focusAreaValue.trim()
      ? focusAreaValue.trim()
      : undefined;

  const countValue = rawArguments.count;
  const count =
    typeof countValue === "number" && Number.isFinite(countValue)
      ? Math.min(Math.max(Math.round(countValue), 1), 5)
      : 3;

  return {
    recentTopics,
    focusArea,
    count,
  };
}

/**
 * recommendNextTopic 的 system prompt。
 *
 * 这个工具和 evaluateAnswer 共享同一个心智模型(LLM 在工具内部当裁判 / 推荐员),
 * 但 rubric 完全不同。这就是 LLM-as-tool 的灵活性——
 * 同一个底层模型,通过 system prompt 切换"人格",做截然不同的事。
 */
const recommendNextTopicSystemPrompt = `
You are an iOS / Swift / AI app development learning coach.

You are given:
- A list of topics the student has recently discussed or learned.
- A list of available topics in the local knowledge base (each with title + fileName).
- An optional focus area (e.g. "SwiftUI", "LangGraph", "RAG").

Your job: recommend the NEXT topics for the student to learn.

Output ONLY valid JSON. No Markdown. No code fences. No surrounding text.

JSON shape (use exactly these keys):
{
  "recommendations": [
    {
      "topic": "...",
      "reason": "...",
      "difficulty": "入门" | "中级" | "进阶",
      "relatedFileName": "...optional, must exactly match a fileName from the available list..."
    }
  ]
}

Rules:
- Generate exactly the number of recommendations requested by the user (between 1 and 5).
- DO NOT recommend topics the student has already covered (look at recentTopics list).
- Prefer recommending topics that exist in the knowledge base — but you may suggest 1 outside-of-KB topic if natural progression demands it.
- For each in-KB recommendation, set relatedFileName to the exact fileName from the available list. For outside-of-KB topics, omit relatedFileName.
- "reason": one short sentence explaining why this is the right next step given what the student has already learned. Same language as the recent topics.
- "topic": short title in the student's language (Chinese if recentTopics are mostly Chinese, English otherwise).
- "difficulty": one of "入门" / "中级" / "进阶" only.
- Be specific. "学习 SwiftUI" is too vague. "@StateObject 的生命周期" is good.
- Do NOT include any explanation or thinking outside the JSON.
`.trim();

type RawRecommendation = {
  topic?: unknown;
  reason?: unknown;
  difficulty?: unknown;
  relatedFileName?: unknown;
};

type RawRecommendationOutput = {
  recommendations?: unknown;
};

function normalizeRecommendationOutput(
  rawText: string,
  availableFileNames: Set<string>,
  expectedCount: number
): {
  recommendations: Array<{
    topic: string;
    reason: string;
    difficulty: "入门" | "中级" | "进阶";
    relatedFileName?: string;
  }>;
} {
  const jsonText = extractJsonFromLlmOutput(rawText);

  if (!jsonText) {
    throw new Error("Recommendation model did not return JSON.");
  }

  const parsed = JSON.parse(jsonText) as RawRecommendationOutput;

  if (!Array.isArray(parsed.recommendations)) {
    throw new Error("Recommendation output missing 'recommendations' array.");
  }

  const validDifficulties = new Set(["入门", "中级", "进阶"]);

  const recommendations = parsed.recommendations
    .filter(isObjectRecord)
    .map((item): {
      topic: string;
      reason: string;
      difficulty: "入门" | "中级" | "进阶";
      relatedFileName?: string;
    } | undefined => {
      const raw = item as RawRecommendation;

      if (typeof raw.topic !== "string" || !raw.topic.trim()) {
        return undefined;
      }
      if (typeof raw.reason !== "string" || !raw.reason.trim()) {
        return undefined;
      }

      const difficultyRaw =
        typeof raw.difficulty === "string" ? raw.difficulty.trim() : "中级";
      const difficulty = (
        validDifficulties.has(difficultyRaw) ? difficultyRaw : "中级"
      ) as "入门" | "中级" | "进阶";

      /**
       * relatedFileName 必须严格匹配知识库现有文件名,
       * 防止模型幻觉出一个不存在的引用。匹配失败的 silently drop。
       */
      const relatedFileNameRaw =
        typeof raw.relatedFileName === "string"
          ? raw.relatedFileName.trim()
          : "";
      const relatedFileName =
        relatedFileNameRaw && availableFileNames.has(relatedFileNameRaw)
          ? relatedFileNameRaw
          : undefined;

      return {
        topic: raw.topic.trim(),
        reason: raw.reason.trim(),
        difficulty,
        relatedFileName,
      };
    })
    .filter(
      (
        item
      ): item is {
        topic: string;
        reason: string;
        difficulty: "入门" | "中级" | "进阶";
        relatedFileName?: string;
      } => item !== undefined
    )
    .slice(0, expectedCount);

  return { recommendations };
}

export async function runRecommendNextTopicTool(
  args: RecommendNextTopicArguments
): Promise<AgentToolExecutionResult> {
  /**
   * 第一步:把知识库的可推荐目录提供给模型。
   *
   * 注意这里只读 metadata.title / fileName,不读 pageContent——
   * 不需要让推荐模型阅读全部文档,光看标题列表就能做"哪个主题该学"的决策。
   * 这是 RAG 的反向操作:不是"按查询找内容",而是"按目录做规划"。
   */
  let availableTopics: Array<{ title: string; fileName: string }>;

  try {
    const documents = await loadKnowledgeDocuments();
    availableTopics = documents.map((document) => ({
      title: document.metadata.title,
      fileName: document.metadata.fileName,
    }));
  } catch (error) {
    return buildToolErrorResult(
      "recommendNextTopic",
      `Failed to load knowledge base index: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  /**
   * 第二步:组装 user prompt,把所有上下文丢给模型。
   *
   * 结构化输入有 3 块:
   *   1. recently learned / discussed topics  (Agent 提取)
   *   2. available knowledge base topics      (本工具自己读)
   *   3. focus area                           (用户传入或 Agent 推断)
   *
   * 用纯 JSON 格式喂给模型,而不是自由文本,
   * 让模型更容易把每一块当结构化数据用,而不是当 prose 阅读。
   */
  const userPayload = {
    recentTopics: args.recentTopics,
    focusArea: args.focusArea ?? null,
    availableKnowledgeBase: availableTopics,
    requestedCount: args.count,
  };

  let rawText: string;

  try {
    rawText = await invokeLangChainChat([
      new SystemMessage(recommendNextTopicSystemPrompt),
      new HumanMessage(JSON.stringify(userPayload, null, 2)),
    ]);
  } catch (error) {
    return buildToolErrorResult(
      "recommendNextTopic",
      `Recommendation model call failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const availableFileNamesSet = new Set(
    availableTopics.map((topic) => topic.fileName)
  );

  try {
    const normalized = normalizeRecommendationOutput(
      rawText,
      availableFileNamesSet,
      args.count
    );

    return {
      toolName: "recommendNextTopic",
      ok: true,
      result: {
        focusArea: args.focusArea,
        recentTopics: args.recentTopics,
        recommendations: normalized.recommendations,
      },
    };
  } catch (error) {
    return {
      toolName: "recommendNextTopic",
      ok: false,
      error: `Failed to parse recommendation output: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function executeLocalAgentTool(
  toolName: string,
  rawArguments: unknown
): Promise<AgentToolExecutionResult> {
  /**
   * 这个函数是本地执行器，保留它有两个用途：
   *
   * 1. MCP server 可以复用同一套工具逻辑
   * 2. 将来写单元测试时，可以绕过 MCP transport 直接测试工具行为
   */
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

    case "evaluateAnswer": {
      const args = normalizeEvaluateAnswerArguments(rawArguments);

      if (!args) {
        return buildToolErrorResult(
          toolName,
          "Invalid arguments. Expected { question: string, userAnswer: string, topic?: string, expectedConcepts?: string[] }."
        );
      }

      return runEvaluateAnswerTool(args);
    }

    case "recommendNextTopic": {
      const args = normalizeRecommendNextTopicArguments(rawArguments);

      if (!args) {
        return buildToolErrorResult(
          toolName,
          "Invalid arguments. Expected { recentTopics: string[], focusArea?: string, count?: number }."
        );
      }

      return runRecommendNextTopicTool(args);
    }

    default:
      return buildToolErrorResult(toolName, `Unknown tool: ${toolName}`);
  }
}
