/**
 * Phase 7.1 一次性调试脚本。
 *
 * 用法:
 *   npx ts-node src/mcp/evaluateAnswerDebug.ts
 *
 * 这只是为了在不启动 Express + MCP transport 的情况下,
 * 直接验证 LLM-as-judge 评分逻辑是否走得通。
 * 验证完可以删掉,不进生产代码路径。
 */
import { runEvaluateAnswerTool } from "./mcpToolHandlers";

async function main(): Promise<void> {
  const cases = [
    {
      label: "优秀答案",
      question: "请用自己的话解释 SwiftUI @State 的作用。",
      userAnswer:
        "@State 是 SwiftUI 给 View 内部用的状态包装器,值变化时会触发 body 重算,从而自动刷新界面。它适合保存简单的本地状态比如 Int 或 Bool,不适合跨多个 View 共享数据,那种场景应该用 ObservableObject 或 @StateObject。",
      topic: "SwiftUI @State",
      expectedConcepts: ["状态保存", "body 重算", "适用范围"],
    },
    {
      label: "及格答案",
      question: "请用自己的话解释 SwiftUI @State 的作用。",
      userAnswer: "@State 是用来存数据的。",
      topic: "SwiftUI @State",
    },
    {
      label: "需要加油答案",
      question: "请用自己的话解释 SwiftUI @State 的作用。",
      userAnswer: "我不知道。",
    },
  ];

  for (const testCase of cases) {
    console.log(`\n========== ${testCase.label} ==========`);
    console.log(`Question: ${testCase.question}`);
    console.log(`Answer: ${testCase.userAnswer}`);

    const result = await runEvaluateAnswerTool({
      question: testCase.question,
      userAnswer: testCase.userAnswer,
      topic: testCase.topic,
      expectedConcepts: testCase.expectedConcepts,
    });

    console.log(`Tool ok: ${result.ok}`);
    console.log(JSON.stringify(result.result, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error("evaluateAnswerDebug failed:", error);
  process.exitCode = 1;
});
