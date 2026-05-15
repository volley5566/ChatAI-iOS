import { retrieveRelevantKnowledge, truncateText } from "../knowledge/knowledge";
import {
  buildToolErrorResult,
  isObjectRecord,
  type AgentToolExecutionResult,
} from "../agent/agentToolTypes";

export type SearchKnowledgeArguments = {
  query: string;
};

export type GenerateQuizArguments = {
  topic: string;
  count?: number;
};

/**
 * mcpToolHandlers.ts 放“真实工具逻辑”。
 *
 * 它不关心：
 * - HTTP 请求/响应
 * - SSE 怎么推给 iOS
 * - DeepSeek 的 tools 格式
 * - MCP 的 transport 是 stdio 还是 HTTP
 *
 * 它只负责把已经校验过的参数变成工具结果。
 * 这样以后工具逻辑可以被 MCP server、单元测试或其他入口复用。
 */

export function normalizeSearchKnowledgeArguments(
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

export function normalizeGenerateQuizArguments(
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

export function runSearchKnowledgeTool(
  args: SearchKnowledgeArguments
): AgentToolExecutionResult {
  /**
   * 当前 RAG 是学习版：Markdown chunk + 关键词匹配。
   *
   * 这里返回的是结构化结果，而不是直接拼 prompt：
   * - MCP client 可以稳定读取 matches 数量
   * - Agent Runner 可以把完整 chunk 结果交回模型
   * - 模型最终回答时可以用 citation 告诉用户参考来源
   * - iOS 可以通过 tool_done 展示“找到 N 条相关资料”
   *
   * 注意：这里暂时不直接把 sources 推给 iOS。
   * 当前版本先让模型在最终回答里自然展示来源；
   * 后续如果要做独立“参考来源 UI”，可以新增 SSE event 或最终 metadata。
   */
  const matches = retrieveRelevantKnowledge(args.query);

  return {
    toolName: "searchKnowledge",
    ok: true,
    result: {
      query: args.query,
      matches: matches.map((match) => ({
        source: match.chunk.fileName,
        title: match.chunk.title,
        section: match.chunk.section,
        citation: match.chunk.citation,
        score: match.score,
        excerpt: truncateText(match.chunk.content, 1200),
      })),
    },
  };
}

export function runGenerateQuizTool(
  args: GenerateQuizArguments
): AgentToolExecutionResult {
  /**
   * 这个工具故意不再调用一次 LLM。
   *
   * 第一轮迭代的目标是跑通工具协议链路：
   * 模型决定调用工具 -> MCP 执行工具 -> 工具结果回模型。
   *
   * 所以 generateQuiz 先用固定模板生成练习题，
   * 让工具行为稳定、易调试。
   */
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

export function executeLocalAgentTool(
  toolName: string,
  rawArguments: unknown
): AgentToolExecutionResult {
  /**
   * 这个函数是本地执行器，保留它有两个用途：
   *
   * 1. MCP server 可以复用同一套工具逻辑
   * 2. 将来写单元测试时，可以绕过 MCP transport 直接测试工具行为
   */
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
      return buildToolErrorResult(toolName, `Unknown tool: ${toolName}`);
  }
}
