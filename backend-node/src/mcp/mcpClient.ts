import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import {
  buildToolErrorResult,
  isObjectRecord,
  type AgentToolExecutionResult,
} from "../agent/agentToolTypes";

type McpAgentClient = {
  listTools(): Promise<McpTool[]>;
  callTool(toolName: string, rawArguments: unknown): Promise<AgentToolExecutionResult>;
  close(): Promise<void>;
};

/**
 * ═══════════════════════════════════════════════════════════════════
 * mcp/mcpClient.ts — 工具调用方(连接 MCP server 的客户端)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 整体工具调用链路:
 *   LangChain Agent
 *        ↓
 *   LangChain Tool wrapper (agentTools.ts)
 *        ↓
 *   这个文件 (mcpClient.ts)
 *        ↓
 *   MCP 协议 (JSON-RPC over stdio)
 *        ↓
 *   mcpServer.ts
 *        ↓
 *   mcpToolHandlers.ts (真实工具实现)
 *
 * 暴露的两个核心方法:
 *   - getMcpToolDefinitions() → 列出所有可用工具(用来 bind 给 LangChain)
 *   - callMcpTool(name, args) → 执行具体工具
 *
 * 全进程单例 + 失败自动重连。
 */

/**
 * MCP SDK 的 callTool 可能返回两种形态:
 *   - 普通工具结果:content / structuredContent
 *   - task 工具结果:toolResult
 *
 * 当前项目没用 MCP task,但这里兼容两种形态,
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

function resetMcpAgentClient(): void {
  /**
   * MCP client 是进程级单例。如果 stdio MCP server 崩了、断管了，或者 SDK 调用抛错，
   * 这个单例很可能已经不可用了。
   *
   * 这里的策略是：
   * - 先把全局 promise 清空，避免后续请求继续复用坏连接
   * - 尝试异步 close 旧 client，但不阻塞当前错误路径
   *
   * 下一次 getMcpAgentClient() 会重新启动 MCP server 子进程。
   */
  const staleClientPromise = mcpAgentClientPromise;
  mcpAgentClientPromise = undefined;

  if (!staleClientPromise) {
    return;
  }

  void staleClientPromise
    .then((client) => client.close())
    .catch(() => {
      // 旧连接本来就可能已经断开，close 失败不需要再扩大影响面。
    });
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
  let cachedTools: McpTool[] | undefined;

  await client.connect(transport);

  return {
    async listTools(): Promise<McpTool[]> {
      /**
       * 工具列表通常不会在运行时频繁变化。
       * 第一次从 MCP server 读取后缓存起来，后续每轮 Agent 请求复用。
       */
      if (cachedTools) {
        return cachedTools;
      }

      const toolsResult = await client.listTools();
      cachedTools = toolsResult.tools;
      return cachedTools;
    },

    async callTool(
      toolName: string,
      rawArguments: unknown
    ): Promise<AgentToolExecutionResult> {
      /**
       * LangChain Tool wrapper 会把模型生成的 arguments 转成普通对象。
       * 这里仍然做一次对象校验，避免异常输入直接穿透到 MCP server。
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

async function getMcpAgentClient(): Promise<McpAgentClient> {//Promise 级单例:并发请求第一次同时来,第二个会等同一个 Promise,不会重复启动子进程
  /**
   * Promise 级别的单例能处理并发初始化：
   * 如果两个请求同时进来，第一个请求开始连接 MCP server，
   * 第二个请求会等待同一个 promise，而不是重复启动子进程。
   */
  if (!mcpAgentClientPromise) {
    mcpAgentClientPromise = createMcpAgentClient().catch((error: unknown) => {
      mcpAgentClientPromise = undefined; // 失败清空,下次重试
      throw error;
    });
  }

  return mcpAgentClientPromise;
}

export async function getMcpToolDefinitions(): Promise<McpTool[]> {
  try {
    const client = await getMcpAgentClient();//单例,第一次会启动 MCP 子进程
    return await client.listTools();  // JSON-RPC over stdio
  } catch (error) {
    /**
     * listTools 是 LangChain Agent 工具阶段的入口。
     * 如果这里失败，通常意味着 MCP server 启动失败或连接已经不可用。
     * 清掉单例后，Agent Runner 可以选择跳过工具阶段或降级；
     * 下一次用户请求再尝试重建 MCP 连接。
     */
    resetMcpAgentClient();
    throw error;
  }
}

export async function callMcpTool(
  toolName: string,
  rawArguments: unknown
): Promise<AgentToolExecutionResult> {
  // 通过 MCP callTool 调工具。
  try {
    const client = await getMcpAgentClient();
    return await client.callTool(toolName, rawArguments);
  } catch (firstError) {
    /**
     * 第一次调用失败时，最常见的可恢复原因是：
     * - MCP server 子进程已经退出
     * - stdio transport 断开
     * - 缓存的 client 处于坏状态
     *
     * 所以这里做一次轻量 retry：
     * 1. 清掉坏单例
     * 2. 重新获取 client，这会重新启动 MCP server
     * 3. 用同一组工具参数再调一次
     *
     * 如果第二次仍失败，就把错误抛给 Agent Runner；
     * Runner 会把它包装成 ok:false 的工具结果，而不是让整个回答失败。
     */
    resetMcpAgentClient();

    try {
      const retryClient = await getMcpAgentClient();
      return await retryClient.callTool(toolName, rawArguments);
    } catch (retryError) {
      resetMcpAgentClient();
      throw retryError;
    }
  }
}

export async function closeMcpAgentClient(): Promise<void> {
  if (!mcpAgentClientPromise) {
    return;
  }

  const client = await mcpAgentClientPromise;
  mcpAgentClientPromise = undefined;
  await client.close();
}
