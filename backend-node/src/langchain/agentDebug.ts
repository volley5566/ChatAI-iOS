import { closeMcpAgentClient } from "../mcp/mcpClient";
/**
 * 注意:这里 import 的是 `../agent/agentRunner`(路由层),不是
 * `./agentRunner`(Phase 3 实现)。
 *
 * 路由层会根据 env `USE_LANGGRAPH` 决定走 Phase 3 createAgent 还是
 * Phase 4 手写 StateGraph。这样这个 debug 脚本和 server.ts 行为一致,
 * 测一次就能验证两条路径。
 */
import { runLangChainAgentStream } from "../agent/agentRunner";
import { closeSqliteCheckpointer } from "../db/sqliteCheckpointer";

/**
 * LangChain Agent 本地调试脚本。
 *
 * 运行方式:
 *
 *   # 不带 thread_id —— 无持久化模式(老行为)
 *   npm run agent:debug -- "SwiftUI @State 是什么?"
 *
 *   # 带 thread_id —— 启用 checkpointer 持久化(Phase 5.2 新增)
 *   USE_LANGGRAPH=true npm run agent:debug -- --thread-id=test1 "我叫 Nathan"
 *   USE_LANGGRAPH=true npm run agent:debug -- --thread-id=test1 "我叫什么名字?"
 *   ↑ 第二次跑模型应该能"记起" Nathan,说明 checkpointer 工作了
 *
 * 注意:
 * - 只有 USE_LANGGRAPH=true(走 Phase 4 StateGraph)时,thread_id 才生效
 * - Phase 3 路径(createAgent)故意不接 checkpointer,传 thread_id 也会被忽略
 */
async function main(): Promise<void> {
  /**
   * 简易参数解析:
   *   - 任何 `--thread-id=xxx` 形式的参数被识别为 thread id
   *   - 剩下的合在一起就是用户消息
   */
  const rawArgs = process.argv.slice(2);
  let threadId: string | undefined;
  const messageParts: string[] = [];

  for (const arg of rawArgs) {
    if (arg.startsWith("--thread-id=")) {
      threadId = arg.slice("--thread-id=".length).trim() || undefined;
    } else {
      messageParts.push(arg);
    }
  }

  const message = messageParts.join(" ").trim();

  if (!message) {
    console.error(
      'Usage: npm run agent:debug -- [--thread-id=<id>] "your question"'
    );
    process.exitCode = 1;
    return;
  }

  console.log("[LangChain Agent Debug] Query:");
  console.log(message);
  if (threadId) {
    console.log(`[LangChain Agent Debug] Thread ID: ${threadId} (checkpointer enabled)`);
  } else {
    console.log("[LangChain Agent Debug] No thread ID (no persistence)");
  }
  console.log("");

  try {
    const result = await runLangChainAgentStream({
      requestId: "agent-debug",
      message,
      systemPrompt: "You are a friendly iOS tutor.",
      history: [],
      threadId, // ← Phase 5.2 新增
      onToolEvent: (event) => {
        /**
         * 这里直接打印 SSE 事件对象。
         * 如果看到 tool_start / tool_done,说明 LangChain Agent 确实调用了工具。
         */
        console.log("");
        console.log(`[LangChain Agent Debug] ${event.type}`);
        console.log(JSON.stringify(event, null, 2));
        console.log("");
      },
      onDelta: (delta) => {
        /**
         * 最终回答仍然按 token/delta 输出,
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
     * 调试脚本结束时主动关闭,避免 Node 因为子进程还开着而挂住。
     */
    await closeMcpAgentClient();
    /**
     * Phase 5.2:同样关掉 SqliteSaver 的连接,让进程能干净退出。
     */
    closeSqliteCheckpointer();
  }
}

void main().catch((error) => {
  console.error("[LangChain Agent Debug] Failed:", error);
  process.exitCode = 1;
});
