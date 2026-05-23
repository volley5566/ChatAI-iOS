/**
 * Phase 7.3 — generateQuiz 调试脚本。
 *
 * 用法:
 *   npm run quiz:debug
 *
 * 验证 LLM 出题质量(题目针对性 + expectedConcepts 是否合理 + 难度梯度)。
 */
import { runGenerateQuizTool } from "./mcpToolHandlers";

async function main(): Promise<void> {
  const cases = [
    { topic: "SwiftUI @State", count: 3 },
    { topic: "LangGraph Checkpointer", count: 3 },
    { topic: "iOS URLSession async/await", count: 2 },
  ];

  for (const testCase of cases) {
    console.log(`\n========== Topic: ${testCase.topic} (count=${testCase.count}) ==========`);

    const result = await runGenerateQuizTool(testCase);

    console.log(`Tool ok: ${result.ok}`);
    if (!result.ok) {
      console.log(`Error: ${result.error}`);
      continue;
    }
    console.log(JSON.stringify(result.result, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error("generateQuizDebug failed:", error);
  process.exitCode = 1;
});
