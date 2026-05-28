/**
 * Phase 10.2 #8 — keyword evaluator:回答里有关键词吗？
 *
 * ──────────────────────────────────────────────────────────────────
 * 用最简单的子串匹配检查 Agent 的回答是否包含期望的关键词。
 *
 * 判分逻辑:
 *   - expected.keywords 没填 → score: null（skip）
 *   - 填了 → 对每个关键词做大小写不敏感的子串匹配
 *   - score = 命中关键词数 / 总关键词数
 *
 * 为什么用子串而不用正则:
 *   - 简单可预测——数据集里写 "@State" 就匹配 "@State",没有转义问题
 *   - 关键词通常是专有名词（@State / VStack / Optional）,子串够用
 *   - 如果将来需要更复杂的匹配,可以加新 evaluator,不改这个
 *
 * Android 类比:
 *   就像 UI 测试里 `onView(withText(containsString("Hello")))`,
 *   只验证文本里有没有出现某个关键词。
 * ──────────────────────────────────────────────────────────────────
 */

import type { Evaluator } from "../lib/types";

export const keywordEvaluator: Evaluator = {
  name: "keyword",

  async evaluate(evalCase, result) {
    if (result.error) {
      return { score: null, reasoning: `Agent error: ${result.error}` };
    }

    const expected = evalCase.expected.keywords;

    if (expected === undefined) {
      return { score: null, reasoning: "expected.keywords not specified, skip" };
    }

    /**
     * 把回答文本转小写,关键词也转小写,然后做 includes 子串匹配。
     *
     * 注意:对于中文关键词(如"闭包"),toLowerCase() 不影响;
     * 对于英文关键词(如 "@State" vs "@state"),能正确忽略大小写。
     */
    const textLower = result.finalText.toLowerCase();

    /**
     * multiturn 场景比较特殊:expected.keywords 是一组备选词,
     * Agent 只需命中其中**任意一个**就算通过。
     *
     * 但对于其它场景(如 rag),每个关键词都应该出现。
     *
     * 当前统一用"命中数/总数"的公式。multiturn 数据集里放了 7 个备选词,
     * 命中 1 个 = 1/7 ≈ 0.14,不太合理。
     *
     * 解决办法:multiturn 场景的 keywords 将来可以改成 1 个概括性的词,
     * 或者加一个 "keywordMode: any" 字段。目前先用简单公式,够用。
     */
    const hits = expected.filter((kw) => textLower.includes(kw.toLowerCase()));

    const score = hits.length / expected.length;
    const missed = expected.filter((kw) => !textLower.includes(kw.toLowerCase()));

    return {
      score,
      reasoning:
        score === 1.0
          ? `all keywords found: [${expected.join(", ")}]`
          : `missed keywords: [${missed.join(", ")}]`,
    };
  },
};
