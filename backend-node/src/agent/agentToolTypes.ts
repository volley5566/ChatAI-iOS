/**
 * Agent 工具共享类型。
 *
 * 放在 agent 目录里，是因为这是“Agent 内部统一结果格式”，
 * 不是 MCP 协议类型，也不是 OpenAI SDK 类型。
 *
 * 好处：
 * - mcpClient.ts 可以把 MCP result 转成这个格式
 * - agentTools.ts 可以用这个格式生成 tool_done 事件
 * - agentRunner.ts 可以把这个格式 JSON.stringify 后交回模型
 */
/**
 * Agent 当前支持的工具名。
 *
 * Phase 7 起从 2 个工具扩展到 4 个,形成完整的"学习闭环":
 *   searchKnowledge       -> 讲解(配合模型自由作答)
 *   generateQuiz          -> 出题
 *   evaluateAnswer        -> 批改  (Phase 7.1 新增)
 *   recommendNextTopic    -> 规划下一步  (Phase 7.2 新增)
 *
 * 这个 union 主要用于类型提示。运行时工具列表是由 MCP server 动态注册的,
 * 加新工具时这里要同步更新——否则 TS 编译能通过,但 IDE 提示会过时。
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
