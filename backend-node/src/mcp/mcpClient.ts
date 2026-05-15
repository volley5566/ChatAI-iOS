import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  buildToolErrorResult,
  isObjectRecord,
  type AgentToolExecutionResult,
} from "../agent/agentToolTypes";

type McpAgentClient = {
  listOpenAiTools(): Promise<ChatCompletionTool[]>;
  callTool(toolName: string, rawArguments: unknown): Promise<AgentToolExecutionResult>;
  close(): Promise<void>;
};

/**
 * 工具调用方。
 *
 * 整体调用流程：
 * DeepSeek tool calling 格式
 *         ↓
 * agentTools.ts 翻译
 *         ↓
 * mcpClient.ts
 *         ↓
 * MCP 协议
 *         ↓
 * mcpServer.ts
 *         ↓
 * mcpToolHandlers.ts 真实工具
 */
/**
 * MCP SDK 的 callTool 可能返回两种形态：
 * - 普通工具结果：包含 content / structuredContent
 * - task 工具结果：包含 toolResult
 *
 * 当前项目没有使用 MCP task，但这里兼容两种形态，
 * 以后升级长任务工具时不用重写 Agent 适配层。
 */
type McpCallToolResponse = Awaited<ReturnType<Client["callTool"]>>;
type McpDirectToolResult = Extract<McpCallToolResponse, { content: unknown[] }>;

/**
 * 单例 MCP client。
 *
 * 一个后端进程里复用同一个 stdio MCP 连接即可：
 * - 避免每次用户发消息都启动新的 MCP server 进程
 * - 避免重复 listTools
 * - 让 Agent 请求路径更稳定
 */
let mcpAgentClientPromise: Promise<McpAgentClient> | undefined;

function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments || "{}");
  } catch {
    return undefined;
  }
}

function buildMcpServerLaunchArgs(): string[] {
  /**
   * dev 环境：
   *   __dirname = backend-node/src/mcp
   *   需要用 ts-node/register 直接跑 mcpServer.ts
   *
   * build 后：
   *   __dirname = backend-node/dist/mcp
   *   直接跑编译后的 mcpServer.js
   */
  const runningFromDist = path.basename(path.resolve(__dirname, "..")) === "dist";
  const serverEntry = path.resolve(
    __dirname,
    runningFromDist ? "mcpServer.js" : "mcpServer.ts"
  );

  if (runningFromDist) {
    return [serverEntry];
  }

  return ["-r", "ts-node/register/transpile-only", serverEntry];
}

function toOpenAiTool(tool: Tool): ChatCompletionTool {
  /**
   * DeepSeek/OpenAI-compatible Chat Completions 不认识 MCP Tool 对象，
   * 它认识的是 OpenAI-compatible function tool。
   *
   * 所以这里做一次协议适配：
   * MCP inputSchema -> OpenAI function.parameters
   *
   * 这也是当前工程最关键的一层桥：
   * 模型仍然按熟悉的 tools/tool_choice 工作，
   * 后端真实执行已经走 MCP。
   */
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || `MCP tool: ${tool.name}`,
      parameters: {
        ...tool.inputSchema,
        additionalProperties: false,
      },
    },
  };
}

function hasDirectToolResult(result: McpCallToolResponse): result is McpDirectToolResult {
  return Array.isArray((result as { content?: unknown }).content);
}

function extractTextContent(result: McpDirectToolResult): string | undefined {
  const textParts = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean);

  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function normalizeMcpToolResult(
  toolName: string,
  result: McpCallToolResponse
): AgentToolExecutionResult {
  /**
   * 统一把 MCP SDK 的工具结果还原成项目内部的 AgentToolExecutionResult。
   *
   * Agent Runner 不需要知道 MCP 的 content/structuredContent 细节，
   * 它只关心：
   * - toolName：哪个工具
   * - ok：是否成功
   * - result/error：交回模型的结果
   */
  if (!hasDirectToolResult(result)) {
    return {
      toolName,
      ok: true,
      result: result.toolResult,
    };
  }

  if (result.isError) {
    return buildToolErrorResult(
      toolName,
      extractTextContent(result) || "MCP tool returned an error."
    );
  }

  if (isObjectRecord(result.structuredContent)) {
    const structuredToolName =
      typeof result.structuredContent.toolName === "string"
        ? result.structuredContent.toolName
        : toolName;
    const ok =
      typeof result.structuredContent.ok === "boolean"
        ? result.structuredContent.ok
        : true;

    return {
      toolName: structuredToolName,
      ok,
      result: result.structuredContent.result,
      error:
        typeof result.structuredContent.error === "string"
          ? result.structuredContent.error
          : undefined,
    };
  }

  return {
    toolName,
    ok: true,
    result: {
      text: extractTextContent(result),
      content: result.content,
    },
  };
}

async function createMcpAgentClient(): Promise<McpAgentClient> {
  /**
   * 这个 client 是“工具调用方”。
   *
   * 它代表后端 Agent 去连接 MCP server：
   * - listTools：拿到 MCP server 暴露了哪些工具
   * - callTool：执行模型选择的具体工具
   */
  const client = new Client({
    name: "ai-ios-chat-backend",
    version: "1.0.0",
  });

  /**
   * stdio transport 会启动一个子进程运行 mcpServer。
   *
   * command 使用 process.execPath，表示用当前 Node 可执行文件启动，
   * 避免不同机器上 node 路径不一致的问题。
   */
  // 它会启动 MCP server 子进程。
  // 当前项目用的是 stdio transport，也就是通过子进程的 stdin/stdout 交换 MCP 消息。
  // MCP Client 第一次使用时，会自动启动 MCP Server 子进程。
  // 当前项目里 MCP 是本地 stdio 模式：Node 后端启动一个 MCP Server 子进程，通过 stdin/stdout 通信。
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: buildMcpServerLaunchArgs(),
    cwd: path.resolve(__dirname, "../.."),
    stderr: "inherit",
  });
  let cachedTools: ChatCompletionTool[] | undefined;

  await client.connect(transport);

  return {
    async listOpenAiTools(): Promise<ChatCompletionTool[]> {
      /**
       * 工具列表通常不会在运行时频繁变化。
       * 第一次从 MCP server 读取后缓存起来，后续每轮 Agent 请求复用。
       */
      if (cachedTools) {
        return cachedTools;
      }

      const toolsResult = await client.listTools();
      cachedTools = toolsResult.tools.map(toOpenAiTool);
      return cachedTools;
    },

    async callTool(
      toolName: string,
      rawArguments: unknown
    ): Promise<AgentToolExecutionResult> {
      /**
       * 模型返回的 function.arguments 是 JSON 字符串。
       * parse 后必须确认是对象，才允许交给 MCP server。
       *
       * 更细的字段校验由 MCP server 的 zod schema 完成。
       */
      if (!isObjectRecord(rawArguments)) {
        return buildToolErrorResult(toolName, "Invalid arguments. Expected an object.");
      }

      const result = await client.callTool({
        name: toolName,
        arguments: rawArguments,
      });

      return normalizeMcpToolResult(toolName, result);
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

async function getMcpAgentClient(): Promise<McpAgentClient> {
  /**
   * Promise 级别的单例能处理并发初始化：
   * 如果两个请求同时进来，第一个请求开始连接 MCP server，
   * 第二个请求会等待同一个 promise，而不是重复启动子进程。
   */
  if (!mcpAgentClientPromise) {
    mcpAgentClientPromise = createMcpAgentClient().catch((error: unknown) => {
      mcpAgentClientPromise = undefined;
      throw error;
    });
  }

  return mcpAgentClientPromise;
}

export async function getMcpAgentTools(): Promise<ChatCompletionTool[]> {
  const client = await getMcpAgentClient();
  return client.listOpenAiTools();
}

export async function executeMcpToolCall(
  toolCall: ChatCompletionMessageToolCall
): Promise<AgentToolExecutionResult> {
  if (toolCall.type !== "function") {
    return buildToolErrorResult("unknown", "Only function tool calls are supported.");
  }

  const client = await getMcpAgentClient();
  // 1. 取出工具名，比如 searchKnowledge。
  const toolName = toolCall.function.name;

  // 2. 把模型给的 JSON 字符串参数 parse 成对象。
  const rawArguments = parseToolArguments(toolCall.function.arguments);

  // 3. 通过 MCP callTool 调工具。
  return client.callTool(toolName, rawArguments);
}

export async function closeMcpAgentClient(): Promise<void> {
  if (!mcpAgentClientPromise) {
    return;
  }

  const client = await mcpAgentClientPromise;
  mcpAgentClientPromise = undefined;
  await client.close();
}
