import type {
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { executeMcpToolCall, getMcpAgentTools } from "../mcp/mcpClient";
import {
  isObjectRecord,
  type AgentToolExecutionResult,
  type AgentToolName,
} from "./agentToolTypes";
import type { ChatStreamEvent } from "../shared/types";

export type { AgentToolExecutionResult, AgentToolName };

/**
 * 从 MCP server 读取工具列表，再转换成 OpenAI-compatible tools。
 *
 * 模型仍然通过 DeepSeek/OpenAI-compatible tool calling 决定调用哪个工具；
 * 真正的工具定义和执行已经下沉到 MCP server。
 *
 * 为什么需要这一层：
 * - DeepSeek Chat Completions 接收的是 OpenAI-compatible tools
 * - MCP server 暴露的是 MCP tools
 * - agentTools.ts 就是两种协议对象之间的“翻译层”
 *
 * 这样 Agent Runner 不需要关心 MCP 细节，
 * MCP server 也不需要关心 DeepSeek 的 tool calling 格式。
 */
export async function getAgentTools(): Promise<ChatCompletionTool[]> {
  return getMcpAgentTools();
}

/**
 * 根据模型返回的 tool_call，通过 MCP client 调用 MCP server。
 *
 * 这是新的工具安全边界：
 * 模型只能请求，后端 MCP client 负责转发，MCP server 负责参数校验和真实执行。
 *
 * 原来的版本是在这个文件里直接 switch 工具名并执行本地函数；
 * 现在改成通过 MCP 调用，后续接更多工具时只扩展 MCP server 即可。
 */
export async function executeAgentTool(
  toolCall: ChatCompletionMessageToolCall
): Promise<AgentToolExecutionResult> {
  return executeMcpToolCall(toolCall);
}

export function stringifyToolResult(result: AgentToolExecutionResult): string {
  return JSON.stringify(result);
}

function getAgentToolDisplayName(toolName: string): string {
  switch (toolName) {
    case "searchKnowledge":
      return "查询知识库";
    case "generateQuiz":
      return "生成练习题";
    default:
      return "执行工具";
  }
}

export function buildToolStartEvent(
  toolCall: ChatCompletionMessageToolCall
): ChatStreamEvent {
  /**
   * tool_start 是给 iOS UI 用的进度事件。
   *
   * 模型刚返回 tool_call 时，真实工具还没执行。
   * 先发 tool_start，可以让用户看到“AI 正在查资料/生成练习题”，
   * 避免工具阶段没有流式文本时界面像卡住。
   */
  const toolName = toolCall.type === "function" ? toolCall.function.name : "unknown";
  const displayName = getAgentToolDisplayName(toolName);

  return {
    type: "tool_start",
    tool_call_id: toolCall.id,
    tool_name: toolName,
    display_name: displayName,
    message: `正在${displayName}`,
  };
}

function getToolResultCount(result: AgentToolExecutionResult): number | undefined {
  if (!isObjectRecord(result.result)) {
    return undefined;
  }

  const matches = result.result.matches;
  const questions = result.result.questions;

  if (Array.isArray(matches)) {
    return matches.length;
  }

  if (Array.isArray(questions)) {
    return questions.length;
  }

  return undefined;
}

function buildToolDoneMessage(result: AgentToolExecutionResult): string {
  /**
   * tool_done 的 message 尽量面向用户，而不是面向程序。
   *
   * iOS 只负责展示这段文本，不需要理解工具内部结构。
   * 如果以后新增工具，可以在这里补充更友好的展示文案。
   */
  const displayName = getAgentToolDisplayName(result.toolName);

  if (!result.ok) {
    return `${displayName}失败：${result.error || "未知错误"}`;
  }

  const resultCount = getToolResultCount(result);

  if (result.toolName === "searchKnowledge") {
    return typeof resultCount === "number"
      ? `已查询知识库，找到 ${resultCount} 条相关资料`
      : "已查询知识库";
  }

  if (result.toolName === "generateQuiz") {
    return typeof resultCount === "number"
      ? `已生成 ${resultCount} 道练习题`
      : "已生成练习题";
  }

  return `${displayName}完成`;
}

export function buildToolDoneEvent(
  toolCall: ChatCompletionMessageToolCall,
  result: AgentToolExecutionResult
): ChatStreamEvent {
  const toolName = toolCall.type === "function" ? toolCall.function.name : result.toolName;

  return {
    type: "tool_done",
    tool_call_id: toolCall.id,
    tool_name: toolName,
    display_name: getAgentToolDisplayName(toolName),
    ok: result.ok,
    message: buildToolDoneMessage(result),
  };
}
