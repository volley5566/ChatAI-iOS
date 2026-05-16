import { buildKnowledgeContext, retrieveRelevantKnowledge } from "../knowledge/knowledge";

/**
 * LangChain RAG 调试脚本。
 *
 * 用法：
 *   npm run rag:debug -- "SwiftUI @State 和 @Binding 有什么区别"
 *
 * 它不会调用 DeepSeek，也不会启动 Express。
 * 它只验证：
 * - Markdown 是否能被 LangChain loader 读到
 * - splitter 是否能切出 chunk
 * - embeddings + MemoryVectorStore 是否能检索出结果
 *
 * 这对学习 RAG 很重要：
 * 如果 AI 回答不理想，先用这个脚本确认“检索到的资料是否正确”，
 * 再去调 prompt 或模型。
 */
async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim();

  if (!query) {
    console.error('Usage: npm run rag:debug -- "your query"');
    process.exitCode = 1;
    return;
  }

  const matches = await retrieveRelevantKnowledge(query);

  console.log(`Query: ${query}`);
  console.log(`Matches: ${matches.length}`);
  console.log("");

  for (const [index, match] of matches.entries()) {
    console.log(`--- Match ${index + 1} ---`);
    console.log(`Score: ${match.score}`);
    console.log(`Citation: ${match.chunk.citation}`);
    console.log(`Chunk ID: ${match.chunk.id}`);
    console.log("Excerpt:");
    console.log(match.chunk.content.slice(0, 500));
    console.log("");
  }

  const promptContext = buildKnowledgeContext(matches);

  if (promptContext) {
    console.log("--- Prompt Context Preview ---");
    console.log(promptContext.slice(0, 1200));
  }
}

main().catch((error: unknown) => {
  console.error("RAG debug failed:", error);
  process.exitCode = 1;
});
