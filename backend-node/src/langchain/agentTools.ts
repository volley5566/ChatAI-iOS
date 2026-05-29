import { tool, type ClientTool, type ToolRuntime } from "@langchain/core/tools";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import {
  buildToolDoneEventFromParts,
  buildToolStartEventFromParts,
} from "../agent/agentTools";
import { buildToolErrorResult } from "../agent/agentToolTypes";
import { toolExecutionTimeoutMs } from "../config/env";
import { callMcpTool, getMcpToolDefinitions } from "../mcp/mcpClient";
import type { ChatStreamEvent } from "../shared/types";

type CreateLangChainAgentToolsOptions = {
  onToolEvent?: (event: ChatStreamEvent) => void;
  onToolCompleted?: () => void;
};

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/agentTools.ts — MCP → LangChain Tool 桥接层
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   agentRunner.ts / agentGraph.ts → 这个文件 → mcp/mcpClient.ts
 *
 * 把 MCP server 注册的工具批量包装成 LangChain ClientTool,
 * 让 createAgent / StateGraph 能直接当工具用。
 *
 * # 这一层的价值
 *   - MCP 仍然是工具协议边界(工具注册、参数 schema、安全注解)
 *   - LangChain Agent 负责工具选择和执行编排
 *   - iOS 仍然收到熟悉的 tool_start / tool_done SSE
 *
 * # 后续新增工具的方法
 *   只要工具出现在 MCP listTools() 里,这里就会自动包装,
 *   不需要改 LangChain 这一层。
 */
export async function createLangChainAgentTools(
  options: CreateLangChainAgentToolsOptions = {}
): Promise<ClientTool[]> {
  const mcpTools = await getMcpToolDefinitions(); // ← 这里跟 MCP server 通信
  return mcpTools.map((mcpTool) => createLangChainToolFromMcpTool(mcpTool, options));
}

function createLangChainToolFromMcpTool(
  mcpTool: McpTool,
  options: CreateLangChainAgentToolsOptions
): ClientTool {
  const schema = {
    ...mcpTool.inputSchema,
    additionalProperties: false,
  };

  return tool(
    async (input: unknown, runtime: ToolRuntime) => {
      /**
       * LangChain 会把模型生成的 tool_call_id 注入 runtime.toolCallId。
       * 我们用它对齐：
       * - 后端日志
       * - iOS tool_start/tool_done
       * - LangChain ToolMessage
       */
      const toolCallId = runtime?.toolCallId || createFallbackToolCallId(mcpTool.name);

      /**
       * 测一次 wall-clock,塞进 tool_done.duration_ms,
       * iOS 端可以直接显示"查询知识库 完成 (213ms)"。
       *
       * startedAt 必须放在 try 之前——异常分支也要能算耗时。
       */
      const startedAt = Date.now();

      options.onToolEvent?.(buildToolStartEventFromParts(toolCallId, mcpTool.name));

      let result: Awaited<ReturnType<typeof callMcpTool>>;

      try {
        result = await withTimeout(
          callMcpTool(mcpTool.name, input),
          toolExecutionTimeoutMs,
          `Tool execution timed out after ${toolExecutionTimeoutMs}ms.`
        );
      } catch (error) {
        /**
         * 工具失败不让整次 Agent 请求直接失败:
         * 把失败包成标准工具结果交回模型,模型自然降级回答。
         *
         * 没接 toolRetryMiddleware 是因为:
         *   - MCP 工具一般要么参数错(重试也没用),要么超时(再来一次只会更慢)
         *   - 学习项目里更想强调"失败被结构化、可观测",而不是"自动重试"
         * 真要重试,可以在 buildAgentMiddleware() 里加 toolRetryMiddleware。
         */
        result = buildToolErrorResult(
          mcpTool.name,
          `Tool execution failed: ${getErrorMessage(error)}`
        );
      }

      const durationMs = Date.now() - startedAt;

      options.onToolCompleted?.();
      options.onToolEvent?.(
        buildToolDoneEventFromParts(toolCallId, mcpTool.name, result, durationMs)
      );

      /**
       * LangChain Tool 的返回值会进入 ToolMessage。
       * 这里返回 JSON 字符串，是为了让模型能稳定看到：
       * - toolName
       * - ok
       * - result / error
       *
       * iOS 不直接展示这份 JSON，只展示上面的 tool_done 摘要。
       */
      return JSON.stringify(result);
    },
    {
      name: mcpTool.name,
      description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
      schema,
    }
  ) as ClientTool;
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return "Unknown error";
}

function createFallbackToolCallId(toolName: string): string {
  return `langchain_${toolName}_${Date.now()}`;
}
