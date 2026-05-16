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
 * 从 MCP server 动态创建 LangChain tools。
 *
 * 这是第二阶段的关键桥接层：
 *
 *   MCP Tool definition
 *      -> LangChain tool(...)
 *      -> LangChain createAgent(...)
 *
 * 好处：
 * - MCP 仍然是工具协议边界，负责工具注册、参数 schema、安全注解
 * - LangChain Agent 负责工具选择和执行编排
 * - iOS 仍然收到熟悉的 tool_start / tool_done 事件
 *
 * 后续新增 MCP 工具时，只要它出现在 listTools() 中，
 * 这里就能自动包装成 LangChain Tool。
 */
export async function createLangChainAgentTools(
  options: CreateLangChainAgentToolsOptions = {}
): Promise<ClientTool[]> {
  const mcpTools = await getMcpToolDefinitions();
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
       * 第三阶段：工具进度更标准。
       *
       * 之前 tool_start / tool_done 只带文案，看不出每个工具实际耗时。
       * 现在 wrapper 内部测一次 wall-clock，最终塞进 tool_done.duration_ms，
       * iOS 端可以直接显示“查询知识库 完成 (213ms)”。
       *
       * 注意 startedAt 必须放在外层 try 之前——异常分支也要能算耗时。
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
         * 和旧 Runner 一样：工具失败不让整次 Agent 请求直接失败。
         * 失败会变成一个标准工具结果交回模型，让模型自然降级回答。
         *
         * 第三阶段没有直接接入 toolRetryMiddleware，是因为：
         * - MCP 工具一般要么参数错（重试也没用），要么超时（再来一次只会更慢）
         * - 学习项目里更想强调“失败被结构化、可观测”，而不是“自动重试”
         * 真要重试，可以在 buildAgentMiddleware() 里加 toolRetryMiddleware。
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
