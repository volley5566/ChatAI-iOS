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
   * 工具从 tool_start 到 tool_done 的耗时（毫秒）。
   *
   * 加这个字段是为了第三阶段的“工具进度更标准”：
   * - iOS 可以直接展示“查询知识库 完成 (213ms)”
   * - 后端日志和 SSE 事件能用同一个 duration 对齐
   *
   * 调用方目前一定会传；保持可选是为了让历史调用点（比如未来加的单元测试）
   * 不需要立即跟着改。
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
