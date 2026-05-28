/**
 * Phase 10.2 #9 — Eval 主入口:读数据集 → 跑 Agent → 评分 → 出报告。
 *
 * ──────────────────────────────────────────────────────────────────
 * 这是整个 eval 体系的"总指挥":
 *   1. 解析 CLI 参数(--quick / --fail-below / --dataset)
 *   2. loadDataset() 读 jsonl
 *   3. 逐条跑 runAgent() 拿 EvalResult
 *   4. 每条 result 过 4 个 evaluator 拿 EvaluatorOutcome
 *   5. 汇总打印成绩单(终端表格)
 *   6. 如果总分低于阈值 → process.exit(1)(给 CI 用)
 *
 * 用法:
 *   npm run eval                        跑全量 21 条
 *   npm run eval -- --quick             只跑前 5 条(省 token)
 *   npm run eval -- --fail-below 0.7    总分 < 0.7 时退出码 1
 *   npm run eval -- --dataset path.jsonl 用其它数据集
 *
 * Android 类比:
 *   这就像 `./gradlew connectedAndroidTest` 的角色——
 *   拉起测试、跑 case、收集结果、输出报告、决定 CI 红绿灯。
 * ──────────────────────────────────────────────────────────────────
 */

import { loadDataset, DEFAULT_DATASET_PATH } from "./lib/dataset";
import { runAgent } from "./lib/runAgent";
import type { EvalCase, EvalResult, Evaluator, EvaluatorOutcome } from "./lib/types";

// 4 个评分器
import { toolChoiceEvaluator } from "./evaluators/toolChoice";
import { keywordEvaluator } from "./evaluators/keyword";
import { toolChainEvaluator } from "./evaluators/toolChain";
import { llmJudgeEvaluator } from "./evaluators/llmJudge";

/**
 * 评分器列表。
 * 加新 evaluator 只需要:
 *   1. 在 evaluators/ 里写一个文件
 *   2. 在这里 import + push 到数组里
 * 其它地方都不用动。
 */
const EVALUATORS: Evaluator[] = [
  toolChoiceEvaluator,
  keywordEvaluator,
  toolChainEvaluator,
  llmJudgeEvaluator,
];

/** --quick 模式下跑多少条 */
const QUICK_LIMIT = 5;

// ─────────────────────────────────────────────────────────────────
// CLI 参数解析
// ─────────────────────────────────────────────────────────────────

type CliArgs = {
  datasetPath: string;
  quick: boolean;
  failBelow: number | null;
};

/**
 * 从 process.argv 里提取参数。
 *
 * 不用 commander / yargs,因为只有 3 个参数,手写更轻量。
 * 参数格式跟 README 里写的一致:
 *   --quick
 *   --fail-below 0.7
 *   --dataset evals/datasets/custom.jsonl
 */
function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  let datasetPath = DEFAULT_DATASET_PATH;
  let quick = false;
  let failBelow: number | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--quick":
        quick = true;
        break;

      case "--fail-below": {
        const val = parseFloat(args[++i]);
        if (isNaN(val) || val < 0 || val > 1) {
          console.error("❌ --fail-below must be a number between 0 and 1");
          process.exit(1);
        }
        failBelow = val;
        break;
      }

      case "--dataset":
        datasetPath = args[++i];
        if (!datasetPath) {
          console.error("❌ --dataset requires a file path");
          process.exit(1);
        }
        break;

      default:
        console.error(`❌ Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return { datasetPath, quick, failBelow };
}

// ─────────────────────────────────────────────────────────────────
// 核心流程
// ─────────────────────────────────────────────────────────────────

/**
 * 单条 case 的完整评测结果(运行结果 + 所有 evaluator 的打分)。
 * 只在 runEval 内部用,不导出。
 */
type CaseReport = {
  evalCase: EvalCase;
  result: EvalResult;
  /** 每个 evaluator 一个 outcome,顺序和 EVALUATORS 数组一致 */
  outcomes: EvaluatorOutcome[];
};

/**
 * 跑一条 case:Agent 答题 → 4 个 evaluator 打分。
 */
async function evaluateOneCase(
  evalCase: EvalCase,
  index: number,
  total: number
): Promise<CaseReport> {
  console.log(`\n🔄 [${index + 1}/${total}] Running case: ${evalCase.id} (${evalCase.scenario})`);

  // 第一步:跑 Agent
  const result = await runAgent(evalCase);

  if (result.error) {
    console.log(`   ❌ Agent error: ${result.error}`);
  } else {
    console.log(`   ✅ Agent responded (${result.durationMs}ms, ${result.toolCalls.length} tool calls)`);
  }

  // 第二步:4 个 evaluator 并行打分
  // 用 Promise.all 因为 evaluator 之间互不依赖,可以并发
  // (实际只有 llmJudge 是 async 有意义的,其它 3 个是同步的)
  const outcomes = await Promise.all(
    EVALUATORS.map((ev) => ev.evaluate(evalCase, result))
  );

  return { evalCase, result, outcomes };
}

// ─────────────────────────────────────────────────────────────────
// 报告输出
// ─────────────────────────────────────────────────────────────────

/**
 * 打印成绩单。
 *
 * 格式:
 *   1. 逐条明细表(case × evaluator 矩阵)
 *   2. 按 scenario 分组统计
 *   3. 按 evaluator 分组统计
 *   4. 总分
 */
function printReport(reports: CaseReport[]): number {
  const evalNames = EVALUATORS.map((e) => e.name);

  // ──── 明细表 ────
  console.log("\n" + "═".repeat(80));
  console.log("📊 EVAL REPORT");
  console.log("═".repeat(80));

  /**
   * 表头:case | scenario | 各 evaluator | duration
   */
  const header = ["case", "scenario", ...evalNames, "ms"].map((h) => h.padEnd(14)).join("");
  console.log(header);
  console.log("─".repeat(80));

  /**
   * 收集所有有效分数(score !== null),用于算总分。
   */
  const allScores: number[] = [];

  /**
   * 按 scenario 分组收集分数,用于分组统计。
   */
  const byScenario = new Map<string, number[]>();

  /**
   * 按 evaluator 分组收集分数。
   */
  const byEvaluator = new Map<string, number[]>();
  for (const name of evalNames) {
    byEvaluator.set(name, []);
  }

  for (const report of reports) {
    const cells: string[] = [
      report.evalCase.id.padEnd(14),
      report.evalCase.scenario.padEnd(14),
    ];

    for (let i = 0; i < report.outcomes.length; i++) {
      const outcome = report.outcomes[i];
      if (outcome.score === null) {
        cells.push("—".padEnd(14));
      } else {
        cells.push(outcome.score.toFixed(2).padEnd(14));
        allScores.push(outcome.score);

        // 按 scenario 收集
        const scenarioScores = byScenario.get(report.evalCase.scenario) ?? [];
        scenarioScores.push(outcome.score);
        byScenario.set(report.evalCase.scenario, scenarioScores);

        // 按 evaluator 收集
        byEvaluator.get(evalNames[i])!.push(outcome.score);
      }
    }

    cells.push(String(report.result.durationMs).padEnd(14));

    // 如果有 error,行末加标记
    const suffix = report.result.error ? " ⚠️ ERROR" : "";
    console.log(cells.join("") + suffix);
  }

  // ──── 按 scenario 统计 ────
  console.log("\n" + "─".repeat(40));
  console.log("📦 By Scenario");
  console.log("─".repeat(40));
  for (const [scenario, scores] of byScenario) {
    const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    console.log(`  ${scenario.padEnd(14)} ${avg.toFixed(3)}  (${scores.length} scores)`);
  }

  // ──── 按 evaluator 统计 ────
  console.log("\n" + "─".repeat(40));
  console.log("📐 By Evaluator");
  console.log("─".repeat(40));
  for (const [name, scores] of byEvaluator) {
    const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    console.log(`  ${name.padEnd(14)} ${avg.toFixed(3)}  (${scores.length} scores)`);
  }

  // ──── 总分 ────
  const overall = allScores.length > 0
    ? allScores.reduce((a, b) => a + b, 0) / allScores.length
    : 0;

  console.log("\n" + "═".repeat(40));
  console.log(`🏆 Overall Score: ${overall.toFixed(3)}  (${allScores.length} total scores from ${reports.length} cases)`);
  console.log("═".repeat(40));

  return overall;
}

// ─────────────────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const { datasetPath, quick, failBelow } = parseCliArgs();

  console.log("🚀 Eval started");
  console.log(`   Dataset:    ${datasetPath}`);
  console.log(`   Mode:       ${quick ? `quick (first ${QUICK_LIMIT} cases)` : "full"}`);
  console.log(`   Fail below: ${failBelow !== null ? failBelow : "(none)"}`);
  console.log(`   Evaluators: ${EVALUATORS.map((e) => e.name).join(", ")}`);

  // 1. 读数据集
  let cases = await loadDataset(datasetPath);

  if (quick) {
    cases = cases.slice(0, QUICK_LIMIT);
  }

  console.log(`\n📋 Loaded ${cases.length} cases`);

  // 2. 逐条跑(串行,避免并发过多 API 调用打爆 rate limit)
  //    将来可以改成受控并发(比如 p-limit 控制 3 路并行)
  const reports: CaseReport[] = [];
  for (let i = 0; i < cases.length; i++) {
    const report = await evaluateOneCase(cases[i], i, cases.length);
    reports.push(report);
  }

  // 3. 打印报告
  const overall = printReport(reports);

  const totalMs = Date.now() - startedAt;
  console.log(`\n⏱️  Total time: ${(totalMs / 1000).toFixed(1)}s`);

  // 4. CI gating:总分低于阈值 → 退出码 1
  if (failBelow !== null && overall < failBelow) {
    console.log(`\n🔴 FAIL: overall ${overall.toFixed(3)} < threshold ${failBelow}`);
    process.exit(1);
  }

  console.log("\n✅ Eval completed");
}

/**
 * 顶层错误兜底。
 * 数据集格式错、文件找不到等致命错误会走这里。
 */
main().catch((error) => {
  console.error("💥 Eval crashed:", error);
  process.exit(2);
});
