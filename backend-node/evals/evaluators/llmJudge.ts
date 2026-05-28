/**
 * Phase 10.2 #8 — llmJudge evaluator:用 LLM 当裁判,语义上回答得对吗？
 *
 * ──────────────────────────────────────────────────────────────────
 * 前面 3 个 evaluator 都是"硬规则"(有没有调 tool、有没有关键词),
 * 这个 evaluator 是"软判断"——让另一个 LLM 比较:
 *
 *   "参考答案是 XXX,Agent 实际回答是 YYY,请打 0-1 分"
 *
 * 为什么需要 LLM judge:
 *   - 硬规则覆盖不了"意思对了但换了个说法"的情况
 *   - 参考答案写"属性包装器",Agent 回答"property wrapper"——
 *     keyword evaluator 会判 0 分,但 LLM judge 知道它们是同一个概念
 *
 * 代价:
 *   - 这是唯一一个**自己也要调 AI** 的 evaluator,每条 case 多一次 API 调用
 *   - 结果有一定随机性(LLM 不是确定性的)
 *   - 所以把它放最后,可以用 --quick 跳过(将来实现)
 *
 * Android 类比:
 *   想象你请一个真人 QA 来审阅 Agent 的回答,给个主观评分。
 *   这个 evaluator 就是用 AI 代替那个 QA。
 * ──────────────────────────────────────────────────────────────────
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { createLangChainChatModel } from "../../src/langchain/chatModel";
import { messageContentToString } from "../../src/langchain/chatPrompt";
import type { Evaluator } from "../lib/types";

/**
 * judge 模型的 system prompt。
 *
 * 设计要点:
 *   - 明确角色:你是评测裁判,不是聊天助手
 *   - 明确评分标准:语义覆盖度,不是字面匹配
 *   - 明确输出格式:JSON { score, reasoning },方便解析
 *   - 允许部分正确:0.5 表示"大致对了但有遗漏"
 */
const JUDGE_SYSTEM_PROMPT = `你是一个 AI 回答质量评测裁判。

你的任务:比较"参考答案"和"实际回答",给出 0 到 1 的评分。

评分标准:
- 1.0: 实际回答完整覆盖了参考答案的核心要点,表述准确
- 0.7-0.9: 大部分要点覆盖,有小的遗漏或不够精确
- 0.4-0.6: 部分正确,但有明显遗漏或错误
- 0.1-0.3: 只答对了很少的部分
- 0.0: 完全错误或答非所问

注意:
- 不要求字面一致,只看语义是否覆盖
- 中英文表述同一概念视为等价(如"属性包装器" = "property wrapper")
- 实际回答比参考答案多出额外信息不扣分
- 只看正确性,不看格式/排版/语气

请严格按以下 JSON 格式输出,不要输出其它内容:
{"score": 0.8, "reasoning": "简短说明"}`;

export const llmJudgeEvaluator: Evaluator = {
  name: "llmJudge",

  async evaluate(evalCase, result) {
    if (result.error) {
      return { score: null, reasoning: `Agent error: ${result.error}` };
    }

    const reference = evalCase.expected.reference;

    if (reference === undefined) {
      return { score: null, reasoning: "expected.reference not specified, skip" };
    }

    /**
     * 构造给 judge 模型的 prompt。
     * 把参考答案和实际回答都贴进去,让 judge 比较。
     */
    const userPrompt = [
      "## 参考答案",
      reference,
      "",
      "## 实际回答",
      result.finalText || "(Agent 没有给出回答)",
      "",
      "请评分并说明理由,输出 JSON。",
    ].join("\n");

    try {
      /**
       * 用 createLangChainChatModel 复用项目里已有的 DeepSeek 配置。
       *
       * 不开 streaming(judge 只需要完整结果,不需要逐 token 回调)。
       * 关掉 thinking(避免 DeepSeek R1 的 thinking mode 干扰输出格式)。
       */
      const chatModel = createLangChainChatModel({
        streaming: false,
        disableThinking: true,
      });

      const response = await chatModel.invoke([
        new SystemMessage(JUDGE_SYSTEM_PROMPT),
        new HumanMessage(userPrompt),
      ]);

      const text = messageContentToString(response.content);

      return parseJudgeResponse(text);
    } catch (error) {
      /**
       * judge 调用失败(网络/API 错误)→ 不给分,skip。
       * 不应该因为 judge 模型挂了让整条 case 标记为"低分"。
       */
      return {
        score: null,
        reasoning: `llmJudge call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/**
 * 解析 judge 模型的 JSON 输出。
 *
 * LLM 输出不一定完美——可能带 markdown code fence,
 * 可能多了换行或空格,甚至可能输出非法 JSON。
 * 所以做了几层容错。
 */
function parseJudgeResponse(text: string): { score: number | null; reasoning: string } {
  /**
   * 先尝试提取 ```json ... ``` code fence 里的内容,
   * 如果没有 code fence 就直接用原文。
   */
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

  try {
    const parsed = JSON.parse(jsonStr);

    /**
     * 校验 score 是合法数字且在 0-1 范围内。
     * 如果 judge 给了个 0.85 这种小数,直接用。
     * 如果给了超范围的值(比如 2.0),夹到 [0, 1]。
     */
    if (typeof parsed.score === "number" && isFinite(parsed.score)) {
      const clampedScore = Math.max(0, Math.min(1, parsed.score));
      const reasoning =
        typeof parsed.reasoning === "string"
          ? parsed.reasoning
          : "no reasoning provided";

      return { score: clampedScore, reasoning };
    }

    return {
      score: null,
      reasoning: `judge returned invalid score: ${JSON.stringify(parsed)}`,
    };
  } catch {
    /**
     * JSON 解析失败 → 试着用正则从文本里扒 score 数字。
     * LLM 有时候会输出 "score: 0.8, reasoning: ..." 而不是标准 JSON。
     */
    const scoreMatch = text.match(/["']?score["']?\s*[:：]\s*([\d.]+)/);
    if (scoreMatch) {
      const score = Math.max(0, Math.min(1, parseFloat(scoreMatch[1])));
      return { score, reasoning: `(parsed from non-JSON output) ${text.slice(0, 200)}` };
    }

    return {
      score: null,
      reasoning: `failed to parse judge output: ${text.slice(0, 200)}`,
    };
  }
}
