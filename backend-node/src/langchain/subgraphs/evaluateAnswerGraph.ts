/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/subgraphs/evaluateAnswerGraph.ts
 *   evaluateAnswer 工具的 3 节点子图实现 (Phase 9 #5)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   mcp/mcpToolHandlers.ts:runEvaluateAnswerTool
 *     └── runEvaluateAnswerSubgraph(args)   ← 这个文件提供的入口
 *           └── 编译一张 3 节点 StateGraph,跑一遍,返回结果
 *
 * # 为什么把"批改答案"拆成子图?
 *
 * 早期版本是一个大函数,做 4 件事:
 *   1. 把 expectedConcepts、question、userAnswer 拼成 prompt
 *   2. 调 DeepSeek
 *   3. 从模型输出里提取 JSON
 *   4. 规范化(score 夹紧到 0-3、缺字段兜底)
 *
 * 大函数能跑,但有几个问题:
 *   - 难单元测试:想测"prompt 拼对了没"必须连真模型
 *   - 难加阶段:想在 grade 后插一个"用 RAG 检索佐证"步骤,要重写整段
 *   - LangSmith trace 看不出内部结构,只显示 "invokeLangChainChat" 一条
 *
 * 拆成子图后:
 *   - 每个节点单独可测(node 函数纯依赖 state)
 *   - 想加阶段 = 加一个 node + 一条 edge,其他节点不动
 *   - LangSmith 自动把每个节点当一个 span,trace 更细
 *
 * # 子图 vs 主图的关系
 *
 * 这张子图:
 *   - 有自己的 state schema (EvaluateAnswerState),和主图 AgentState 完全独立
 *   - 是普通 CompiledStateGraph,可以 invoke / stream / streamEvents 调
 *   - 不接 checkpointer(批改流程是"一次性的",不需要恢复中间态)
 *   - 通过 runEvaluateAnswerSubgraph() 函数暴露,调用方不感知图的存在
 *
 * # 子图节点流程
 *
 *   START
 *     ↓
 *   prepareContext       ← 把 args 包装成 systemPrompt + userPrompt
 *     ↓                    (根据 expectedConcepts 调整 rubric 措辞)
 *   gradeWithLLM         ← 调 DeepSeek 拿 raw JSON
 *     ↓
 *   validateAndNormalize ← JSON.parse + 字段校验 + 兜底
 *     ↓
 *    END
 *
 * 每个节点都是 (state) => Partial<state>,LangGraph 用 reducer 合并更新。
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { invokeLangChainChat } from "../chatModel";

// ─── 类型定义 ──────────────────────────────────────────────────

/** 调用方传进来的 4 个字段(和原 EvaluateAnswerArguments 一致) */
export type EvaluateAnswerInput = {
  question: string;
  userAnswer: string;
  topic?: string;
  expectedConcepts?: string[];
};

/** 最终的批改结果(原 normalizeEvaluationOutput 的返回类型) */
export type EvaluateAnswerOutput = {
  score: 0 | 1 | 2 | 3;
  scoreLabel: string;
  strengths: string[];
  weaknesses: string[];
  suggestedAnswer: string;
  /**
   * 解析失败时填上原始模型输出的截断版,给 iOS / 日志做"degraded fallback"。
   * undefined 表示一切正常。
   */
  parseError?: string;
};

// ─── 子图 State Schema ────────────────────────────────────────

/**
 * 子图的 state 通道,**和主图 AgentState 完全独立**。
 *
 * 设计原则:
 *   - 输入字段 (question/userAnswer/...) 在 invoke 时塞进去
 *   - 中间字段 (systemPrompt/userPrompt/rawLlmOutput) 由前置节点填
 *   - 输出字段 (evaluation) 由最后一个节点填
 *
 * 这种"层层填充"的 pattern 是 StateGraph 的标准玩法,
 * 每个节点只关心自己的输入和输出,不用知道其它节点的存在。
 *
 * 注意:这里所有 reducer 都用默认的"覆盖"语义(后写的覆盖先写的),
 * 因为没有节点会"追加"同一个字段。不像主图的 messages 需要 messagesStateReducer。
 */
const EvaluateAnswerState = Annotation.Root({
  // ── 输入 (调用方塞,节点只读) ─────────────
  question: Annotation<string>(),
  userAnswer: Annotation<string>(),
  topic: Annotation<string | undefined>(),
  expectedConcepts: Annotation<string[] | undefined>(),

  // ── 中间 (prepareContext 填,gradeWithLLM 读) ──
  systemPrompt: Annotation<string>(),
  userPrompt: Annotation<string>(),

  // ── 中间 (gradeWithLLM 填,validateAndNormalize 读) ──
  rawLlmOutput: Annotation<string>(),

  // ── 输出 (validateAndNormalize 填,外部读) ────
  evaluation: Annotation<EvaluateAnswerOutput | undefined>(),
});

type EvaluateAnswerStateType = typeof EvaluateAnswerState.State;
type EvaluateAnswerStateUpdate = Partial<EvaluateAnswerStateType>;

// ─── 节点 1:prepareContext ────────────────────────────────────

/**
 * 节点 1:把 args 包装成 LLM 能直接用的 system / user prompt。
 *
 * 这里有一段"动态调 rubric"的小逻辑:
 *   - 如果调用方传了 expectedConcepts,告诉模型"重点检查这些要点"
 *   - 没传就让模型自己从 question 推断
 *
 * 把它单独做成节点的价值:测试时可以**完全不调模型**,
 * 直接 assert prepareContext(input).systemPrompt 是否包含 "expectedConcepts" 关键词。
 */
const gradingSystemPromptBase = `
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

function prepareContext(
  state: EvaluateAnswerStateType
): EvaluateAnswerStateUpdate {
  const contextParts: string[] = [];

  if (state.topic) {
    contextParts.push(`Topic: ${state.topic}`);
  }

  if (state.expectedConcepts && state.expectedConcepts.length > 0) {
    // expectedConcepts 来自 generateQuiz 时记下的"期望要点",
    // 喂给评分模型可以让批改更精准。没传就让模型自己推断。
    contextParts.push(
      `Expected concepts to mention: ${state.expectedConcepts.join(", ")}`
    );
  }

  contextParts.push(`Question:\n${state.question}`);
  contextParts.push(`Student answer:\n${state.userAnswer}`);

  return {
    systemPrompt: gradingSystemPromptBase,
    userPrompt: contextParts.join("\n\n"),
  };
}

// ─── 节点 2:gradeWithLLM ──────────────────────────────────────

/**
 * 节点 2:用前一个节点准备好的 prompt 调 DeepSeek。
 *
 * 这是子图里**唯一会发起 LLM 网络请求**的节点,也是最慢的一步
 * (DeepSeek 通常 2-5 秒)。把它隔离出来好处:
 *   - LangSmith trace 里能清晰看到"批改 LLM 调用"这个 span
 *   - 重试 / 限流逻辑以后只需要包这一个节点,不影响别的
 *
 * 失败处理:这里**故意不 try/catch**,让异常冒到调用方
 * (runEvaluateAnswerSubgraph)统一处理。
 */
async function gradeWithLLM(
  state: EvaluateAnswerStateType
): Promise<EvaluateAnswerStateUpdate> {
  const rawLlmOutput = await invokeLangChainChat([
    new SystemMessage(state.systemPrompt),
    new HumanMessage(state.userPrompt),
  ]);

  return { rawLlmOutput };
}

// ─── 节点 3:validateAndNormalize ──────────────────────────────

/**
 * 节点 3:解析 LLM 输出的 JSON,做防御性 normalize。
 *
 * 这一步**也是不调 LLM 的纯函数**,完全可测试。
 *
 * 防御要点:
 *   - 模型偶尔会把 score 写成 "2" 字符串或者 99 这种越界值 → 夹紧到 0-3
 *   - 模型可能漏字段 → 用 fallback 填(scoreLabel 用 score 索引数组)
 *   - JSON 解析失败 → 设 evaluation.parseError,suggestedAnswer 塞原始文本截断
 *     这样 iOS 至少能看到模型说了什么,而不是空白
 */
function validateAndNormalize(
  state: EvaluateAnswerStateType
): EvaluateAnswerStateUpdate {
  const jsonText = extractJsonFromLlmOutput(state.rawLlmOutput);

  if (!jsonText) {
    return {
      evaluation: buildFallbackEvaluation(
        state.rawLlmOutput,
        "LLM 没返回 JSON"
      ),
    };
  }

  try {
    const parsed = JSON.parse(jsonText) as RawEvaluation;
    return { evaluation: normalizeParsedEvaluation(parsed) };
  } catch (error) {
    return {
      evaluation: buildFallbackEvaluation(
        state.rawLlmOutput,
        error instanceof Error ? error.message : "Unknown parse error"
      ),
    };
  }
}

// ─── 编译图(一次性,模块级缓存) ─────────────────────────────

/**
 * 把节点拼成图。LangGraph 编译有些开销,所以模块级只编一次。
 *
 * 注意没传 checkpointer:批改是一次性流程,跑完即丢,
 * 不需要持久化中间态(和主图 AgentState 用 SqliteCheckpointer 不同)。
 */
const compiledEvaluateAnswerGraph = new StateGraph(EvaluateAnswerState)
  .addNode("prepareContext", prepareContext)
  .addNode("gradeWithLLM", gradeWithLLM)
  .addNode("validateAndNormalize", validateAndNormalize)
  .addEdge(START, "prepareContext")
  .addEdge("prepareContext", "gradeWithLLM")
  .addEdge("gradeWithLLM", "validateAndNormalize")
  .addEdge("validateAndNormalize", END)
  .compile();

// ─── 对外入口 ─────────────────────────────────────────────────

/**
 * 对外暴露的入口函数:输入参数 → 跑子图 → 返回批改结果。
 *
 * 调用方(mcpToolHandlers.ts:runEvaluateAnswerTool)看到的就是一个普通的
 * `async (args) => result` 函数,完全不知道里面是张图。
 *
 * # 失败处理
 *
 * 两类失败:
 *   1. LLM 调用挂了(网络 / 超时 / API 报错):let error 冒出来,
 *      让 runEvaluateAnswerTool 包装成 ok=false 的 AgentToolExecutionResult
 *   2. LLM 返回了但解析失败:validateAndNormalize 节点已经填好 fallback,
 *      函数仍然返回 EvaluateAnswerOutput(带 parseError 字段)—— 算成功的降级
 */
export async function runEvaluateAnswerSubgraph(
  input: EvaluateAnswerInput
): Promise<EvaluateAnswerOutput> {
  const finalState = await compiledEvaluateAnswerGraph.invoke({
    question: input.question,
    userAnswer: input.userAnswer,
    topic: input.topic,
    expectedConcepts: input.expectedConcepts,
  });

  // validateAndNormalize 节点保证 evaluation 一定有值(成功 or fallback),
  // 但 TS 类型上它仍然是 optional —— 这里非空断言,如果真为 nil 是图配置 bug。
  if (!finalState.evaluation) {
    throw new Error(
      "evaluateAnswerGraph: subgraph ended without producing evaluation. " +
        "This is a graph misconfiguration bug, not a user error."
    );
  }

  return finalState.evaluation;
}

// ─── 内部辅助函数(纯函数,无副作用) ──────────────────────────

type RawEvaluation = {
  score?: unknown;
  scoreLabel?: unknown;
  strengths?: unknown;
  weaknesses?: unknown;
  suggestedAnswer?: unknown;
};

/**
 * 从 LLM 输出文本中提取首尾 {} 之间的 JSON。
 * 模型偶尔会包 ```json ... ``` 或前后多写几个字,这里宽松提取。
 *
 * 和 mcpToolHandlers.ts 里的同名函数实现一致;
 * 重复一份是为了让 subgraphs/ 不依赖 mcp/ 目录(子图是底层,工具是上层)。
 */
function extractJsonFromLlmOutput(rawText: string): string | undefined {
  const startIndex = rawText.indexOf("{");
  const endIndex = rawText.lastIndexOf("}");
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }
  return rawText.slice(startIndex, endIndex + 1);
}

function normalizeParsedEvaluation(parsed: RawEvaluation): EvaluateAnswerOutput {
  // 防御性 normalize:模型偶尔返回 "2" 字符串 / 99 越界值
  const rawScore =
    typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
  const safeScore = Number.isFinite(rawScore)
    ? Math.min(Math.max(Math.round(rawScore), 0), 3)
    : 0;
  const score = safeScore as 0 | 1 | 2 | 3;

  const labelFallback = ["需要加油", "及格", "良好", "优秀"][score];
  const scoreLabel =
    typeof parsed.scoreLabel === "string" && parsed.scoreLabel.trim()
      ? parsed.scoreLabel.trim()
      : labelFallback;

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

/**
 * 解析失败时的降级输出:让 iOS 至少看到模型说了什么,
 * 同时通过 parseError 字段告诉前端"这是降级结果"。
 */
function buildFallbackEvaluation(
  rawText: string,
  errorMessage: string
): EvaluateAnswerOutput {
  return {
    score: 1,
    scoreLabel: "及格",
    strengths: [],
    weaknesses: ["评分模型输出格式异常,以下内容为原始回答"],
    suggestedAnswer: truncate(rawText, 600),
    parseError: errorMessage,
  };
}

function toStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}...`;
}
