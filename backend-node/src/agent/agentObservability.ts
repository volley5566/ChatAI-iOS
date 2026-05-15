import { randomUUID } from "crypto";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

const maxStringLength = 1200;
const maxArrayItems = 20;
const maxObjectKeys = 40;
const maxDepth = 5;

export function createAgentRequestId(): string {
  return randomUUID();
}

export function getDurationMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function truncateText(value: string): string {
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
  writeAgentLog("info", requestId, phase, event, data);
}

export function logAgentError(
  requestId: string,
  phase: string,
  event: string,
  error: unknown,
  data: Record<string, unknown> = {}
): void {
  writeAgentLog("error", requestId, phase, event, {
    ...data,
    error: serializeError(error),
  });
}

function parseToolArguments(rawArguments: string): unknown {
  if (!rawArguments) {
    return {};
  }

  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

export function getToolCallLogData(
  toolCall: ChatCompletionMessageToolCall
): Record<string, unknown> {
  if (toolCall.type !== "function") {
    return {
      toolCallId: toolCall.id,
      toolType: toolCall.type,
    };
  }

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    arguments: parseToolArguments(toolCall.function.arguments),
  };
}
