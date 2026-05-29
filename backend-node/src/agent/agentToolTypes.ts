/**
 * ═══════════════════════════════════════════════════════════════════
 * agent/agentToolTypes.ts — Agent 工具共享类型(项目内部统一结果格式)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   mcpClient.ts 把 MCP result 转成 AgentToolExecutionResult
 *   agentTools.ts 用它生成 tool_done 事件
 *   LangChain Tool wrapper 把它 JSON.stringify 后交回模型
 *
 * 放在 agent/ 目录:这是"Agent 内部统一结果格式",
 * 不是 MCP 协议类型,也不是 OpenAI SDK 类型——是项目自己的边界类型。
 */

/**
 * Agent 当前支持的工具名(4 个工具组成学习闭环):
 *   searchKnowledge       → 讲解(配合模型自由作答)
 *   generateQuiz          → 出题
 *   evaluateAnswer        → 批改
 *   recommendNextTopic    → 规划下一步
 *
 * 这个 union 主要用于类型提示。运行时工具列表由 MCP server 动态注册——
 * 加新工具时这里要同步更新,否则 TS 编译能通过但 IDE 提示会过时。
 */
export type AgentToolName =
  | "searchKnowledge"
  | "generateQuiz"
  | "evaluateAnswer"
  | "recommendNextTopic";

export type AgentToolExecutionResult = {
  toolName: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildToolErrorResult(
  toolName: string,
  error: string
): AgentToolExecutionResult {
  return {
    toolName,
    ok: false,
    error,
  };
}
