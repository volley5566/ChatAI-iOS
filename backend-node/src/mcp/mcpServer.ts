import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  runGenerateQuizTool,
  runSearchKnowledgeTool,
} from "./mcpToolHandlers";

/**
 * 是工具提供方
 *
 * 这个文件是“工具提供方”：MCP Server。
 *
 * 可以把它理解成一个标准化的工具插座：
 * - 它不直接面对 iOS
 * - 它不直接面对 DeepSeek
 * - 它只通过 MCP 协议暴露工具能力
 *
 * 当前为了学习和本地联调，使用 stdio transport：
 * 后端里的 mcpClient.ts 会自动启动这个进程，
 * 然后通过 stdin/stdout 和它交换 JSON-RPC 消息。
 *
 * 以后如果要把工具服务部署成独立服务，可以把 transport 换成
 * Streamable HTTP，但工具注册这部分基本可以保留。
 */
const mcpServer = new McpServer({
  name: "ai-ios-chat-demo-mcp",
  version: "1.0.0",
});

/**
 * searchKnowledge 是一个只读工具。
 *
 * MCP 的工具定义里最重要的是 inputSchema：
 * - MCP client 会通过 listTools 读取这个 schema
 * - 后端再把它转换成 OpenAI-compatible tools
 * - 模型看到 schema 后，才知道应该传 { query: string }
 *
 * 注意：模型不会直接执行这里的函数。
 * 只有当模型返回 tool_call，后端 MCP client 调用 callTool 时，
 * 这里的 handler 才会真正运行。
 */
// 它注册了两个工具。
// MCP Server 执行真实工具。
mcpServer.registerTool(
  "searchKnowledge",
  {
    title: "查询知识库",
    description:
      "Search the local Markdown knowledge base for iOS, SwiftUI, backend, RAG, streaming, MCP, and project concepts.",
    inputSchema: {
      // 里面有 schema。
      // 这里用 zod 做参数校验。
      // 这就是 MCP server 的安全边界：模型传来的参数，必须符合 schema，才会真正执行。
      // 这表示模型必须传 { query: string }，否则工具不执行。
      query: z
        .string()
        .trim()
        .min(1)
        .describe("A concise search query, for example 'SwiftUI @State' or 'URLSession JSON request'."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  // 真正执行在这里。
  async ({ query }) => {
    /**
     * runSearchKnowledgeTool 会去本地 Markdown 知识库检索，然后返回 matches。
     * 这就是你可以理解成：MCP 是工具入口，知识库是其中一个具体工具能力。
     */
    const toolResult = await runSearchKnowledgeTool({ query });

    /**
     * MCP tool result 支持两种常用输出：
     *
     * 1. content
     *    给通用 MCP 客户端展示用，通常是 text/image/resource 等。
     *
     * 2. structuredContent
     *    给程序继续处理用。这里保留 toolName/ok/result，
     *    这样 mcpClient.ts 可以稳定还原成 AgentToolExecutionResult。
     */
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(toolResult.result, null, 2),
        },
      ],
      structuredContent: {
        toolName: toolResult.toolName,
        ok: toolResult.ok,
        result: toolResult.result,
      },
    };
  }
);

/**
 * generateQuiz 同样是只读/无副作用工具。
 *
 * 这里的 count 用 zod 限制在 1 到 5，
 * 这相当于 MCP server 侧的安全边界：
 * 即使模型传了 100，schema 校验也会拦住不合理参数。
 */
mcpServer.registerTool(
  "generateQuiz",
  {
    title: "生成练习题",
    description:
      "Generate beginner-friendly practice questions for a learning topic. Use this for exercises, quizzes, review, or testing understanding.",
    inputSchema: {
      topic: z
        .string()
        .trim()
        .min(1)
        .describe("The learning topic, for example 'SwiftUI @State' or 'iOS URLSession'."),
      count: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("How many questions to generate. Keep it between 1 and 5."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ topic, count }) => {
    const toolResult = runGenerateQuizTool({ topic, count });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(toolResult.result, null, 2),
        },
      ],
      structuredContent: {
        toolName: toolResult.toolName,
        ok: toolResult.ok,
        result: toolResult.result,
      },
    };
  }
);

async function main(): Promise<void> {
  /**
   * StdioServerTransport 会占用当前进程的 stdin/stdout。
   *
   * 所以这个文件里所有日志都写到 stderr（console.error），
   * 避免日志混进 stdout 后破坏 MCP JSON-RPC 协议消息。
   */
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("AI iOS Chat Demo MCP server is running on stdio.");
}

main().catch((error: unknown) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
