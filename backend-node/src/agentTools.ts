import type {
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { retrieveRelevantKnowledge, truncateText } from "./knowledge";
import type { ChatStreamEvent } from "./types";

export type AgentToolName = "searchKnowledge" | "generateQuiz";

type SearchKnowledgeArguments = {
  query: string;
};

type GenerateQuizArguments = {
  topic: string;
  count?: number;
};

export type AgentToolExecutionResult = {
  toolName: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

/**
 * 提供给模型看的工具列表。
 *
 * 模型不会真的执行函数，只会返回 tool_call；
 * 真正执行工具的是后端的 executeAgentTool。
 */
export const agentTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "searchKnowledge",
      description:
        "Search the local Markdown knowledge base for iOS, SwiftUI, backend, RAG, streaming, and project concepts. Use this before answering questions that may depend on project docs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A concise search query, for example 'SwiftUI @State' or 'URLSession JSON request'.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generateQuiz",
      description:
        "Generate beginner-friendly practice questions for a learning topic. Use this when the user asks for exercises, quiz questions, practice, review, or wants to test understanding.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The learning topic, for example 'SwiftUI @State' or 'iOS URLSession'.",
          },
          count: {
            type: "integer",
            description:
              "How many questions to generate. Keep it between 1 and 5.",
            minimum: 1,
            maximum: 5,
          },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
  },
];

function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments || "{}");
  } catch {
    return undefined;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSearchKnowledgeArguments(
  rawArguments: unknown
): SearchKnowledgeArguments | undefined {
  if (!isObjectRecord(rawArguments)) {
    return undefined;
  }

  const query = rawArguments.query;

  if (typeof query !== "string") {
    return undefined;
  }

  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return undefined;
  }

  return { query: trimmedQuery };
}

function normalizeGenerateQuizArguments(
  rawArguments: unknown
): GenerateQuizArguments | undefined {
  if (!isObjectRecord(rawArguments)) {
    return undefined;
  }

  const topic = rawArguments.topic;

  if (typeof topic !== "string") {
    return undefined;
  }

  const trimmedTopic = topic.trim();

  if (!trimmedTopic) {
    return undefined;
  }

  const countValue = rawArguments.count;
  const count =
    typeof countValue === "number" && Number.isFinite(countValue)
      ? Math.min(Math.max(Math.round(countValue), 1), 5)
      : 3;

  return {
    topic: trimmedTopic,
    count,
  };
}

function runSearchKnowledgeTool(
  args: SearchKnowledgeArguments
): AgentToolExecutionResult {
  const matches = retrieveRelevantKnowledge(args.query);

  return {
    toolName: "searchKnowledge",
    ok: true,
    result: {
      query: args.query,
      matches: matches.map((match) => ({
        source: match.document.fileName,
        title: match.document.title,
        score: match.score,
        excerpt: truncateText(match.document.content, 1200),
      })),
    },
  };
}

function runGenerateQuizTool(
  args: GenerateQuizArguments
): AgentToolExecutionResult {
  const templates = [
    `请用自己的话解释 ${args.topic} 的核心作用。`,
    `请举一个适合使用 ${args.topic} 的具体 iOS 开发场景。`,
    `请说明 ${args.topic} 常见的一个误区，并写出正确理解。`,
    `如果你要把 ${args.topic} 讲给初学者，你会用什么类比？`,
    `请写一个和 ${args.topic} 相关的小代码片段或伪代码思路。`,
  ];

  return {
    toolName: "generateQuiz",
    ok: true,
    result: {
      topic: args.topic,
      count: args.count ?? 3,
      questions: templates.slice(0, args.count ?? 3).map((question, index) => ({
        number: index + 1,
        question,
      })),
    },
  };
}

function buildToolErrorResult(
  toolName: string,
  error: string
): AgentToolExecutionResult {
  return {
    toolName,
    ok: false,
    error,
  };
}

/**
 * 根据模型返回的 tool_call 执行真正的后端工具。
 *
 * 这是 Tool Calling 的安全边界：
 * 模型只能请求，后端负责校验工具名、校验参数、执行真实函数。
 */
export function executeAgentTool(
  toolCall: ChatCompletionMessageToolCall
): AgentToolExecutionResult {
  if (toolCall.type !== "function") {
    return buildToolErrorResult("unknown", "Only function tool calls are supported.");
  }

  const toolName = toolCall.function.name as AgentToolName;
  const rawArguments = parseToolArguments(toolCall.function.arguments);

  switch (toolName) {
    case "searchKnowledge": {
      const args = normalizeSearchKnowledgeArguments(rawArguments);

      if (!args) {
        return buildToolErrorResult(toolName, "Invalid arguments. Expected { query: string }.");
      }

      return runSearchKnowledgeTool(args);
    }

    case "generateQuiz": {
      const args = normalizeGenerateQuizArguments(rawArguments);

      if (!args) {
        return buildToolErrorResult(
          toolName,
          "Invalid arguments. Expected { topic: string, count?: number }."
        );
      }

      return runGenerateQuizTool(args);
    }

    default:
      return buildToolErrorResult(
        toolCall.function.name,
        `Unknown tool: ${toolCall.function.name}`
      );
  }
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
