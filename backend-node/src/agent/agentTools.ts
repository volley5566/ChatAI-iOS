import {
  isObjectRecord,
  type AgentToolExecutionResult,
  type AgentToolName,
} from "./agentToolTypes";
import type { ChatStreamEvent } from "../shared/types";

export type { AgentToolExecutionResult, AgentToolName };

/**
 * ═══════════════════════════════════════════════════════════════════
 * agent/agentTools.ts — 工具执行过程 → iOS SSE 事件的转换层
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   langchain/agentTools.ts(MCP 桥接 wrapper)调这里的两个 builder:
 *     buildToolStartEventFromParts(toolCallId, toolName)
 *     buildToolDoneEventFromParts(toolCallId, toolName, result, durationMs)
 *   产出标准 ChatStreamEvent,再发给 iOS。
 *
 * # 职责边界
 *   这个文件只做"工具执行过程 → 安全的 UI 摘要"。
 *   不负责工具决策、不负责工具执行(那是 LangChain Agent 的事)、
 *   不暴露完整工具结果给 iOS(完整结果作为 ToolMessage 交回 Agent)。
 */

function getAgentToolDisplayName(toolName: string): string {
  switch (toolName) {
    case "searchKnowledge":
      return "查询知识库";
    case "generateQuiz":
      return "生成练习题";
    case "evaluateAnswer":
      return "批改答题";
    case "recommendNextTopic":
      return "推荐学习方向";
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
  const recommendations = result.result.recommendations;

  if (Array.isArray(matches)) {
    return matches.length;
  }

  if (Array.isArray(questions)) {
    return questions.length;
  }

  if (Array.isArray(recommendations)) {
    return recommendations.length;
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

  if (result.toolName === "recommendNextTopic") {
    return typeof resultCount === "number"
      ? `已生成 ${resultCount} 个学习建议`
      : "已生成学习建议";
  }

  if (result.toolName === "evaluateAnswer") {
    /**
     * 批改完直接把评分 + label 显示出来。
     * iOS 端拿到 tool_done.message 就能在卡片标题里直接展示 "良好 (2/3)"。
     */
    if (isObjectRecord(result.result)) {
      const score = result.result.score;
      const scoreLabel = result.result.scoreLabel;

      if (typeof score === "number" && typeof scoreLabel === "string") {
        return `已批改:${scoreLabel} (${score}/3)`;
      }
    }
    return "已批改答题";
  }

  return `${displayName}完成`;
}

export function buildToolDoneEventFromParts(
  toolCallId: string,
  toolName: string,
  result: AgentToolExecutionResult,
  /**
   * 工具从 tool_start 到 tool_done 的耗时(毫秒)。
   * iOS 可以直接展示"查询知识库 完成 (213ms)"。
   * 调用方目前一定会传,保持可选只是为了让未来加的单元测试不用立即跟着改。
   */
  durationMs?: number
): ChatStreamEvent {
  return {
    type: "tool_done",
    tool_call_id: toolCallId,
    tool_name: toolName,
    display_name: getAgentToolDisplayName(toolName),
    ok: result.ok,
    message: buildToolDoneMessage(result),
    duration_ms: durationMs,
  };
}
