/**
 * Phase 10.2 #8 — toolChoice evaluator:Agent 调对 tool 了吗？
 *
 * ──────────────────────────────────────────────────────────────────
 * 这是最基础的 evaluator——只看"有没有调对 tool",不管顺序。
 *
 * 判分逻辑:
 *   - expected.tools 没填          → score: null(skip,这道题我不改)
 *   - expected.tools = []（空数组）→ 表示"不该调任何 tool"
 *       - 实际也没调 → 1.0
 *       - 实际调了   → 0.0
 *   - expected.tools = ["searchKnowledge", ...]
 *       - score = 命中数 / 期望数
 *       - 多调不扣分（Agent 多查了点资料不算错）
 *
 * Android 类比:
 *   就像测试一个按钮"点击后应该发起网络请求",
 *   你只验证 OkHttp 是否被调用了,不管调了几次、什么顺序。
 * ──────────────────────────────────────────────────────────────────
 */

import type { Evaluator } from "../lib/types";

export const toolChoiceEvaluator: Evaluator = {
  name: "toolChoice",

  async evaluate(evalCase, result) {
    /**
     * Agent 跑出异常 → 跳过所有 evaluator。
     * 报告里这条 case 会标记为"error",不计入任何维度的分母。
     */
    if (result.error) {
      return { score: null, reasoning: `Agent error: ${result.error}` };
    }

    const expected = evalCase.expected.tools;

    /**
     * expected.tools 没填 → 这条 case 不测 tool 维度,跳过。
     * 比如 explain 场景只验证关键词,不管 Agent 调不调 tool。
     */
    if (expected === undefined) {
      return { score: null, reasoning: "expected.tools not specified, skip" };
    }

    /**
     * expected.tools = [] → 期望"不调任何 tool"（chat 场景）。
     * 这和"没填"是两回事:
     *   - 没填(undefined) = 我不关心调不调
     *   - 空数组([])     = 我关心,而且期望不调
     */
    if (expected.length === 0) {
      if (result.toolCalls.length === 0) {
        return { score: 1.0, reasoning: "correctly called no tools" };
      }
      return {
        score: 0.0,
        reasoning: `expected no tool calls, but got: [${result.toolCalls.join(", ")}]`,
      };
    }

    /**
     * 正常情况:检查期望的每个 tool 是否在实际 toolCalls 里出现过。
     *
     * 用 Set 做去重后再查——因为同一个 tool 可能被调多次
     * (比如 searchKnowledge 调了两次),我们只关心"有没有调过"。
     */
    const actualSet = new Set(result.toolCalls);
    const hits = expected.filter((t) => actualSet.has(t));

    const score = hits.length / expected.length;
    const missed = expected.filter((t) => !actualSet.has(t));

    return {
      score,
      reasoning:
        score === 1.0
          ? `all expected tools called: [${expected.join(", ")}]`
          : `missed tools: [${missed.join(", ")}], actual: [${result.toolCalls.join(", ")}]`,
    };
  },
};
