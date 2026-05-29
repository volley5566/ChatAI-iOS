import { randomUUID } from "crypto";

/**
 * ═══════════════════════════════════════════════════════════════════
 * agent/agentObservability.ts — Agent 链路结构化日志 + requestId 生成
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   agentRunner.ts / agentGraph.ts / server.ts 在关键节点调:
 *     logAgentInfo(requestId, phase, event, data)
 *     logAgentError(requestId, phase, event, error, data)
 *
 * # 这个文件只负责"怎么记录日志",不参与业务决策
 *   - 不决定模型要不要调工具
 *   - 不执行 MCP tool
 *   - 不写 SSE
 *
 * # 统一 JSON envelope 格式
 *   { timestamp, level, requestId, phase, event, data }
 *   - phase  → 链路阶段(tool_setup / tool_execution / model_call ...)
 *   - event  → 具体事件(started / completed / failed)
 *   这样后端日志可以按 requestId grep 出完整时间线。
 */
const maxStringLength = 1200;
const maxArrayItems = 20;
const maxObjectKeys = 40;
const maxDepth = 5;

export function createAgentRequestId(): string {
  /**
   * 每次 /api/agent/stream 请求生成一个 requestId。
   *
   * 这个 id 会同时出现在：
   * - HTTP response header: X-Request-ID
   * - SSE event: request_id
   * - 后端 console 结构化日志
   *
   * 所以当 iOS 端反馈“这次回答有问题”时，可以用 requestId
   * 直接在后端日志里定位完整链路。
   */
  return randomUUID();
}

export function getDurationMs(startedAt: number): number {
  /**
   * 统一用 Date.now() 计算耗时，日志里全部写 durationMs。
   * 这里没有用高精度计时，是因为当前目标是排查 Agent 链路慢在哪里，
   * 毫秒级 wall-clock 已经足够，而且更容易和日志时间戳对齐。
   */
  return Date.now() - startedAt;
}

function truncateText(value: string): string {
  /**
   * 工具结果可能包含知识库全文、长 JSON、错误 stack。
   * 日志保留前 1200 字符，一般足够排查问题，同时避免终端被大对象刷爆。
   */
  if (value.length <= maxStringLength) {
    return value;
  }

  return `${value.slice(0, maxStringLength)}...<truncated ${value.length - maxStringLength} chars>`;
}

function sanitizeForLog(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  /**
   * 把任意值整理成适合 JSON.stringify 的结构。
   *
   * 为什么不直接 console.log(data)？
   * - Error 默认 stringify 后信息很少
   * - 循环引用会让 JSON.stringify 抛错
   * - 工具返回可能非常大
   * - 深层对象可能让日志失去可读性
   *
   * 这个函数做四件事：
   * 1. 长字符串截断
   * 2. 数组/对象限制大小
   * 3. 循环引用保护
   * 4. Error 转成 name/message/stack
   */
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncateText(value);
  }

  if (typeof value === "undefined") {
    return undefined;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= maxDepth) {
    return "[MaxDepth]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const output = value
      .slice(0, maxArrayItems)
      .map((item) => sanitizeForLog(item, depth + 1, seen));

    if (value.length > maxArrayItems) {
      output.push(`...<truncated ${value.length - maxArrayItems} items>`);
    }

    seen.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);

  for (const [key, entryValue] of entries.slice(0, maxObjectKeys)) {
    output[key] = sanitizeForLog(entryValue, depth + 1, seen);
  }

  if (entries.length > maxObjectKeys) {
    output._truncatedKeys = entries.length - maxObjectKeys;
  }

  seen.delete(value);
  return output;
}

export function serializeError(error: unknown): Record<string, unknown> {
  /**
   * catch (error) 在 TypeScript 里是 unknown。
   * 这里统一把它转成结构化对象，方便日志平台或 grep 读取。
   */
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ? truncateText(error.stack) : undefined,
    };
  }

  return {
    value: sanitizeForLog(error),
  };
}

function writeAgentLog(
  level: "info" | "error",
  requestId: string,
  phase: string,
  event: string,
  data: Record<string, unknown> = {}
): void {
  /**
   * 所有 Agent 日志都走同一个 JSON envelope：
   * {
   *   timestamp,
   *   level,
   *   requestId,
   *   phase,
   *   event,
   *   data
   * }
   *
   * phase 表示当前链路阶段，例如 tool_setup / tool_decision / tool_execution。
   * event 表示这个阶段里的具体事件，例如 started / completed / failed。
   */
  const record = {
    timestamp: new Date().toISOString(),
    level,
    requestId,
    phase,
    event,
    data: sanitizeForLog(data),
  };
  const line = `[Agent] ${JSON.stringify(record)}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export function logAgentInfo(
  requestId: string,
  phase: string,
  event: string,
  data: Record<string, unknown> = {}
): void {
  /**
   * 普通链路事件用 info：
   * 请求进入、工具列表加载完成、模型决定调用工具、最终回答完成等。
   */
  writeAgentLog("info", requestId, phase, event, data);
}

export function logAgentError(
  requestId: string,
  phase: string,
  event: string,
  error: unknown,
  data: Record<string, unknown> = {}
): void {
  /**
   * 错误事件用 error。
   *
   * 注意：记录 error 不代表一定要中断请求。
   * 例如工具执行失败时，Agent Runner 会记录 error，
   * 然后把失败包装成 ok:false 的 tool result 继续最终回答。
   */
  writeAgentLog("error", requestId, phase, event, {
    ...data,
    error: serializeError(error),
  });
}
