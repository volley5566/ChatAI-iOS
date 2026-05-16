import {
  isObjectRecord,
  type AgentToolExecutionResult,
  type AgentToolName,
} from "./agentToolTypes";
import type { ChatStreamEvent } from "../shared/types";

export type { AgentToolExecutionResult, AgentToolName };

/**
 * Agent 工具 UI 事件辅助函数。
 *
 * 第二阶段以后，工具决策和工具执行交给 LangChain Agent / LangChain Tool。
 * 但 iOS 端已经约定好展示这些 SSE 事件：
 *
 *   tool_start
 *   tool_done
 *
 * 所以这个文件不再负责工具 schema / tool wrapper 适配，只保留“把工具执行过程
 * 转成 iOS 能展示的安全摘要”这一层。
 */

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

export function buildToolStartEventFromParts(
  toolCallId: string,
  toolName: string
): ChatStreamEvent {
  const displayName = getAgentToolDisplayName(toolName);

  return {
    type: "tool_start",
    tool_call_id: toolCallId,
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
   * tool_done 的 message 面向用户，不直接暴露完整工具结果。
   *
   * 完整结果会作为 ToolMessage 交回 LangChain Agent，
   * 由模型自己组织最终回答；iOS 只显示执行进度摘要。
   */
  const displayName = getAgentToolDisplayName(result.toolName);

  if (!result.ok) {
    return `${displayName}失败：${result.error || "未知错误"}`;
  }

  const resultCount = getToolResultCount(result);

  if (result.toolName === "searchKnowledge") {
    return typeof resultCount === "number"
      ? `已查询知识库，找到 ${resultCount} 段相关资料`
      : "已查询知识库";
  }

  if (result.toolName === "generateQuiz") {
    return typeof resultCount === "number"
      ? `已生成 ${resultCount} 道练习题`
      : "已生成练习题";
  }

  return `${displayName}完成`;
}

export function buildToolDoneEventFromParts(
  toolCallId: string,
  toolName: string,
  result: AgentToolExecutionResult
): ChatStreamEvent {
  return {
    type: "tool_done",
    tool_call_id: toolCallId,
    tool_name: toolName,
    display_name: getAgentToolDisplayName(toolName),
    ok: result.ok,
    message: buildToolDoneMessage(result),
  };
}
