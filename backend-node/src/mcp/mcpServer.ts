import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  runEvaluateAnswerTool,
  runGenerateQuizTool,
  runRecommendNextTopicTool,
  runSearchKnowledgeTool,
} from "./mcpToolHandlers";

/**
 * ═══════════════════════════════════════════════════════════════════
 * mcp/mcpServer.ts — 工具提供方(MCP server,独立子进程运行)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   mcpClient.ts 启动这个文件作为子进程,通过 stdin/stdout 交换 JSON-RPC。
 *
 * # 把这个文件理解成"标准化的工具插座":
 *   - 不直接面对 iOS
 *   - 不直接面对 DeepSeek
 *   - 只通过 MCP 协议暴露工具能力
 *
 * # 当前注册的 4 个工具:
 *   - searchKnowledge      → RAG 知识库检索(纯本地)
 *   - generateQuiz         → 出题(LLM-as-tool)
 *   - evaluateAnswer       → 批改(LLM-as-judge)
 *   - recommendNextTopic   → 推荐下一个学习方向(LLM-as-tool)
 *
 * # transport 选择
 *   当前用 stdio(本地联调最简单)。以后部署成独立服务可以换成
 *   Streamable HTTP,工具注册这部分代码不用动。
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
 * - langchain/agentTools.ts 会把它包装成 LangChain tool
 * - LangChain Agent 看到 schema 后，才知道应该传 { query: string }
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
      "Generate practice questions for a learning topic. Each question comes with expectedConcepts (used internally by evaluateAnswer for accurate grading) and a difficulty label. Use this for exercises, quizzes, review, or testing understanding.",
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
      // 内部调 LLM,同样的 topic 两次调用模型出题会略有不同,所以 idempotent=false
      idempotentHint: false,
    },
  },
  async ({ topic, count }) => {
    const toolResult = await runGenerateQuizTool({ topic, count });

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
 * evaluateAnswer — 批改工具。
 *
 * 它和 searchKnowledge / generateQuiz 都是只读工具(不改任何持久状态),
 * 但有一个本质区别:**工具内部会再发一次 LLM 请求**。
 *
 * 这就是 "LLM-as-judge" 模式——把"主观评判"封装成工具,
 * 让 Agent 调用,而不是让 Agent 自己用 chat 的方式做评判。
 *
 * 好处:
 * - 评分语境隔离:Agent 的对话语气不会污染评分逻辑
 * - 输出结构稳定:工具内部用严格 rubric prompt 强制 JSON
 * - iOS 可以专门做"批改卡片"UI,而不是混在对话气泡里
 */
mcpServer.registerTool(
  "evaluateAnswer",
  {
    title: "批改答题",
    description:
      "Grade a student's answer to a learning question. Use this after the student provides an answer to a quiz question or any question that requires evaluation. Returns score (0-3), strengths, weaknesses, and a suggested answer.",
    inputSchema: {
      question: z
        .string()
        .trim()
        .min(1)
        .describe("The original question being answered."),
      userAnswer: z
        .string()
        .trim()
        .min(1)
        .describe("The student's answer to evaluate."),
      topic: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional topic context, for example 'SwiftUI @State'. Helps the grader stay on-topic."
        ),
      expectedConcepts: z
        .array(z.string().trim().min(1))
        .max(6)
        .optional()
        .describe(
          "Optional list of key concepts the answer should cover. If provided (typically from generateQuiz output), grading will check these explicitly."
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      /**
       * 注意:这里 idempotentHint = false。
       * 因为内部调用 LLM,同样输入两次,模型回答可能略有差异(温度 > 0)。
       * 这个标记是给 MCP 客户端的"语义提示",对 Agent 行为没影响,
       * 但写对它是 MCP 协议素养的一部分。
       */
      idempotentHint: false,
    },
  },
  async ({ question, userAnswer, topic, expectedConcepts }) => {
    const toolResult = await runEvaluateAnswerTool({
      question,
      userAnswer,
      topic,
      expectedConcepts,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(toolResult.result ?? { error: toolResult.error }, null, 2),
        },
      ],
      structuredContent: {
        toolName: toolResult.toolName,
        ok: toolResult.ok,
        result: toolResult.result,
        error: toolResult.error,
      },
    };
  }
);

/**
 * recommendNextTopic — 学习规划工具。
 *
 * 它和 evaluateAnswer 都是"工具内部调 LLM"的模式,
 * 但用途完全不同——一个是"做裁判",一个是"做规划"。
 *
 * 关键设计:
 * - 这个工具会自己读知识库目录(loadKnowledgeDocuments),
 *   作为推荐范围。模型不能瞎编"建议学习 X",X 必须在知识库里存在,
 *   或者明确标记为"超出知识库的下一步"。
 * - Agent 必须从对话历史里提取 recentTopics 传进来。
 *   这种"工具不去窥探外部状态,只接受显式参数"的设计,
 *   能让工具被测试、被复用,也避免和 LangGraph thread state 强耦合。
 */
mcpServer.registerTool(
  "recommendNextTopic",
  {
    title: "推荐下一个学习方向",
    description:
      "Recommend the next topics for the student to learn based on what they have already covered. Use this when the user asks 'what should I learn next', '下一步学什么', '推荐一下', or after they've successfully understood a topic and is ready to move on. The agent must extract recentTopics from conversation history.",
    inputSchema: {
      recentTopics: z
        .array(z.string().trim().min(1))
        .max(20)
        .describe(
          "Topics the student has already learned or discussed. Extract these from recent conversation. Can be an empty array if the user is just starting."
        ),
      focusArea: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional focus area like 'SwiftUI', 'LangGraph', 'RAG'. Helps narrow the recommendation. If not provided, the tool will infer from recentTopics."
        ),
      count: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("How many recommendations to return. Defaults to 3."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      /**
       * 同样标 idempotentHint=false——内部 LLM 调用,温度 > 0 时输出会有微抖动。
       */
      idempotentHint: false,
    },
  },
  async ({ recentTopics, focusArea, count }) => {
    const toolResult = await runRecommendNextTopicTool({
      recentTopics,
      focusArea,
      count: count ?? 3,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(toolResult.result ?? { error: toolResult.error }, null, 2),
        },
      ],
      structuredContent: {
        toolName: toolResult.toolName,
        ok: toolResult.ok,
        result: toolResult.result,
        error: toolResult.error,
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
