/**
 * Phase 7.2 — recommendNextTopic 调试脚本。
 *
 * 用法:
 *   npm run recommend:debug
 *
 * 跳过 Express 和 MCP transport,直接验证工具内部 LLM 推荐逻辑。
 */
import { runRecommendNextTopicTool } from "./mcpToolHandlers";

async function main(): Promise<void> {
  const cases = [
    {
      label: "刚学完 @State, 想知道下一步",
      recentTopics: ["SwiftUI @State"],
      focusArea: "SwiftUI",
      count: 3,
    },
    {
      label: "完全空白的初学者(空 recentTopics)",
      recentTopics: [],
      count: 3,
    },
    {
      label: "已经学了一堆 LangGraph 相关",
      recentTopics: [
        "LangGraph StateGraph",
        "MessagesState reducer",
        "checkpointer 持久化",
        "thread_id 多轮记忆",
      ],
      focusArea: "LangGraph",
      count: 3,
    },
  ];

  for (const testCase of cases) {
    console.log(`\n========== ${testCase.label} ==========`);
    console.log(`recentTopics: ${JSON.stringify(testCase.recentTopics)}`);
    console.log(`focusArea: ${testCase.focusArea ?? "(none)"}`);

    const result = await runRecommendNextTopicTool({
      recentTopics: testCase.recentTopics,
      focusArea: testCase.focusArea,
      count: testCase.count,
    });

    console.log(`Tool ok: ${result.ok}`);
    if (!result.ok) {
      console.log(`Error: ${result.error}`);
      continue;
    }
    console.log(JSON.stringify(result.result, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error("recommendNextTopicDebug failed:", error);
  process.exitCode = 1;
});
