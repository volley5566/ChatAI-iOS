/**
 * Phase 11 #2 一次性调试脚本。
 *
 * 用法:
 *   npm run summarize:debug
 *
 * 目的:不启动 Express / LangGraph 运行时,直接验证 summarizeNode 的核心逻辑:
 *   1. 能否正确找到"安全切点"(从 HumanMessage 边界切)
 *   2. 调 DeepSeek 摘要返回的 summary 是否合理
 *   3. 第二次跑时(带 existingSummary)能否做迭代式压缩
 *
 * 这段脚本不进生产代码路径,作用相当于 evaluateAnswerDebug.ts。
 */
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { runSummarizeStandalone } from "./summarizeNode";

async function main(): Promise<void> {
  // 模拟一段较长的"用户学 SwiftUI"对话,带工具调用
  const messages = [
    new HumanMessage({ id: "m1", content: "我想学 SwiftUI 的 @State,你能讲讲吗?" }),
    new AIMessage({
      id: "m2",
      content:
        "@State 是 SwiftUI 给 View 内部用的状态包装器,值变化时会触发 body 重算,从而自动刷新界面。",
    }),
    new HumanMessage({ id: "m3", content: "和 @Binding 有什么区别?" }),
    new AIMessage({
      id: "m4",
      content:
        "@Binding 是用来把父视图的 @State 引用传给子视图的,子视图改它等于改父视图的源头。",
    }),
    new HumanMessage({ id: "m5", content: "举个具体的代码例子" }),
    new AIMessage({
      id: "m6",
      content:
        "比如父视图: `@State var isOn = false; Toggle(isOn: $isOn)`,子视图用 `@Binding var isOn: Bool` 接收。",
    }),
    new HumanMessage({ id: "m7", content: "出 3 道相关练习题" }),
    new AIMessage({
      id: "m8",
      content: "",
      tool_calls: [
        {
          id: "call_quiz_1",
          name: "generateQuiz",
          args: { topic: "SwiftUI @State 和 @Binding", count: 3 },
        },
      ],
    }),
    new ToolMessage({
      id: "m9",
      tool_call_id: "call_quiz_1",
      name: "generateQuiz",
      content: JSON.stringify({
        ok: true,
        result: {
          questions: [
            { q: "@State 适合保存什么样的数据?" },
            { q: "@Binding 和 @State 在内存里是什么关系?" },
            { q: "什么时候应该用 @StateObject 而不是 @State?" },
          ],
        },
      }),
    }),
    new AIMessage({
      id: "m10",
      content: "题目已出好,见上方。回答时尽量说出你的思路,我可以帮你点评。",
    }),
    new HumanMessage({ id: "m11", content: "再讲讲 @ObservedObject" }),
    new AIMessage({
      id: "m12",
      content:
        "@ObservedObject 接收一个外部传入的 ObservableObject,不拥有它的生命周期。",
    }),
  ];

  // ─── 测试 1: 第一次摘要(无前置 summary) ─────────────
  console.log("\n========== 测试 1:首次摘要 (keepLastTurns=2) ==========");
  console.log(`输入消息数: ${messages.length}`);
  console.log("HumanMessage id 序列: m1, m3, m5, m7, m11");
  console.log("→ 保留最后 2 个回合 = 从 m7 开始保留 → 应压缩 m1~m6 (6 条)");

  const result1 = await runSummarizeStandalone({
    messages,
    existingSummary: "",
    keepLastTurns: 2,
  });

  console.log("\n--- 输出 ---");
  console.log(`压缩消息 id: [${result1.removedIds.join(", ")}]`);
  console.log(`新 summary (${result1.summary.length} 字符):`);
  console.log(`  "${result1.summary}"`);

  // ─── 测试 2: 迭代摘要(带前置 summary) ─────────────
  console.log("\n========== 测试 2:迭代摘要 (existingSummary 非空, keepLastTurns=1) ==========");
  console.log("→ 这次只保留最后 1 个回合 = 从 m11 开始 → 应压缩 m1~m10 (10 条)");
  console.log("→ 用测试 1 的 summary 作为 existingSummary,看是否能合并");

  const result2 = await runSummarizeStandalone({
    messages,
    existingSummary: result1.summary,
    keepLastTurns: 1,
  });

  console.log("\n--- 输出 ---");
  console.log(`压缩消息 id: [${result2.removedIds.join(", ")}]`);
  console.log(`新 summary (${result2.summary.length} 字符):`);
  console.log(`  "${result2.summary}"`);

  // ─── 测试 3: 回合数不够 ─────────────
  console.log("\n========== 测试 3:回合数不够 (keepLastTurns=10) ==========");
  console.log("→ 总共只有 5 个 HumanMessage,要保留 10 个 → 不压缩");

  const result3 = await runSummarizeStandalone({
    messages,
    existingSummary: "",
    keepLastTurns: 10,
  });

  console.log("\n--- 输出 ---");
  console.log(`压缩消息 id: [${result3.removedIds.join(", ") || "(空)"}]`);
  console.log(`新 summary: "${result3.summary || "(空)"}"`);

  console.log("\n✅ 测试完成");
}

main().catch((error: unknown) => {
  console.error("summarizeDebug failed:", error);
  process.exitCode = 1;
});
