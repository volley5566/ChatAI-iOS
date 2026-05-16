import { closeMcpAgentClient } from "../mcp/mcpClient";
import { runLangChainAgentStream } from "./agentRunner";

/**
 * LangChain Agent 本地调试脚本。
 *
 * 运行方式：
 *
 *   npm run agent:debug -- "SwiftUI @State 和 @Binding 有什么区别？请先查知识库再回答。"
 *
 * 和 rag:debug 的区别：
 * - rag:debug 只测试 Document -> Splitter -> Embedding -> Vector Store -> Retriever
 * - agent:debug 会真的调用 ChatDeepSeek，让 LangChain Agent 自己决定是否使用 MCP tools
 *
 * 所以这个脚本需要 .env 里有 DEEPSEEK_API_KEY。
 */
async function main(): Promise<void> {
  const message = process.argv.slice(2).join(" ").trim();

  if (!message) {
    console.error("Usage: npm run agent:debug -- \"your question\"");
    process.exitCode = 1;
    return;
  }

  console.log("[LangChain Agent Debug] Query:");
  console.log(message);
  console.log("");

  try {
    const result = await runLangChainAgentStream({
      requestId: "agent-debug",
      message,
      systemPrompt: "You are a friendly iOS tutor.",
      history: [],
      onToolEvent: (event) => {
        /**
         * 这里直接打印 SSE 事件对象。
         * 如果看到 tool_start / tool_done，说明 LangChain Agent 确实调用了工具。
         */
        console.log("");
        console.log(`[LangChain Agent Debug] ${event.type}`);
        console.log(JSON.stringify(event, null, 2));
        console.log("");
      },
      onDelta: (delta) => {
        /**
         * 最终回答仍然按 token/delta 输出，
         * 这样本地脚本和 iOS SSE 的体验保持一致。
         */
        process.stdout.write(delta);
      },
    });

    console.log("");
    console.log("");
    console.log("[LangChain Agent Debug] Completed");
    console.log(`Tool calls: ${result.toolCallCount}`);
    console.log(`Output chars: ${result.outputText.length}`);
  } finally {
    /**
     * mcpClient.ts 会启动 stdio MCP server 子进程。
     * 调试脚本结束时主动关闭，避免 Node 因为子进程还开着而挂住。
     */
    await closeMcpAgentClient();
  }
}

void main().catch((error) => {
  console.error("[LangChain Agent Debug] Failed:", error);
  process.exitCode = 1;
});
