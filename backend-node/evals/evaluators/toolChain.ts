/**
 * Phase 10.2 #8 — toolChain evaluator:tool 调用顺序对吗？
 *
 * ──────────────────────────────────────────────────────────────────
 * 比 toolChoice 更严格——不仅要调对 tool,还要按正确的顺序。
 *
 * 使用场景举例:
 *   用户说"先查知识库再出题",期望 chain: ["searchKnowledge", "generateQuiz"]
 *   Agent 如果反过来先出题再查,toolChoice 会给满分(两个都调了),
 *   但 toolChain 会给 0 分(顺序不对)。
 *
 * 判分逻辑:
 *   - expected.chain 没填 → score: null（skip）
 *   - 填了 → 检查实际 toolCalls 的前 N 项是否完全匹配 chain
 *   - 完全匹配 → 1.0
 *   - 不匹配 → 0.0（严格,不给半分——顺序这件事要么对要么不对）
 *
 * "前 N 项匹配"的设计:
 *   如果 chain = ["A", "B"],实际调了 ["A", "B", "C"],
 *   前两项匹配就算通过——Agent 多做了一步不扣分。
 *   但如果调了 ["A", "C", "B"],第二项就不匹配,0 分。
 *
 * Android 类比:
 *   就像测试一个多步流程(登录 → 拉数据 → 渲染),
 *   步骤必须按顺序来,跳步或倒序都是 bug。
 * ──────────────────────────────────────────────────────────────────
 */

import type { Evaluator } from "../lib/types";

export const toolChainEvaluator: Evaluator = {
  name: "toolChain",

  async evaluate(evalCase, result) {
    if (result.error) {
      return { score: null, reasoning: `Agent error: ${result.error}` };
    }

    const expected = evalCase.expected.chain;

    if (expected === undefined) {
      return { score: null, reasoning: "expected.chain not specified, skip" };
    }

    /**
     * 实际 toolCalls 数量不够 → 一定不匹配。
     * 比如期望 ["A", "B"] 但只调了 ["A"],长度不够,0 分。
     */
    if (result.toolCalls.length < expected.length) {
      return {
        score: 0.0,
        reasoning: `expected chain [${expected.join(" → ")}], but only got ${result.toolCalls.length} calls: [${result.toolCalls.join(" → ")}]`,
      };
    }

    /**
     * 逐项比对:actual[0] === expected[0], actual[1] === expected[1], ...
     * 只比前 expected.length 项,后面多出来的不管。
     */
    for (let i = 0; i < expected.length; i++) {
      if (result.toolCalls[i] !== expected[i]) {
        return {
          score: 0.0,
          reasoning: `chain mismatch at step ${i + 1}: expected "${expected[i]}", got "${result.toolCalls[i]}". Full actual: [${result.toolCalls.join(" → ")}]`,
        };
      }
    }

    return {
      score: 1.0,
      reasoning: `chain matched: [${expected.join(" → ")}]`,
    };
  },
};
