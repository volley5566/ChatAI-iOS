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
export type AgentToolName = "searchKnowledge" | "generateQuiz";

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
