/**
 * ═══════════════════════════════════════════════════════════════════
 * chat/structuredAnswer.ts — 把 AI 返回的 JSON 文本转成 ChatResponseBody
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   /api/chat 路由拿到模型返回的字符串 → parseStructuredAnswer →
 *   ChatResponseBody { title, summary, points, next_question } → 返回 iOS
 *
 * # 为什么需要这个文件
 *   模型偶尔会写坏 JSON(夹带未转义引号、多余 markdown 代码围栏等)。
 *   这里做"双层防御":
 *     1. 先尝试 JSON.parse(提取 {...} 部分)
 *     2. parse 失败时用正则从"像 JSON 的文本"提取字段
 *   保证 iOS 永远能拿到结构化结果,即使模型抽风。
 */

import type { ChatResponseBody } from "../shared/types";

function extractJsonText(rawText: string): string {
  const startIndex = rawText.indexOf("{");
  const endIndex = rawText.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error("AI response does not contain a JSON object.");
  }

  return rawText.slice(startIndex, endIndex + 1);
}

function normalizeStructuredAnswer(
  value: unknown,
  rawAnswer: string
): ChatResponseBody {
  const data = value as Partial<Record<keyof ChatResponseBody, unknown>>;

  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : "AI 回答";

  const summary =
    typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : rawAnswer.trim() || "AI 已返回回答，但内容为空。";

  const points = Array.isArray(data.points)
    ? data.points
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  const nextQuestion =
    typeof data.next_question === "string" && data.next_question.trim()
      ? data.next_question.trim()
      : "你想继续了解哪一部分？";

  return {
    title,
    summary,
    points,
    next_question: nextQuestion,
  };
}

function cleanupRawAnswerForDisplay(rawAnswer: string): string {
  return rawAnswer
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/^\s*\{\s*/, "")
    .replace(/\s*\}\s*$/, "")
    .trim();
}

function extractJsonLikeField(
  rawAnswer: string,
  fieldName: string,
  nextFieldName?: string
): string | undefined {
  const startPattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const startMatch = startPattern.exec(rawAnswer);

  if (!startMatch) {
    return undefined;
  }

  const valueStartIndex = startMatch.index + startMatch[0].length;
  const valueEndPattern = nextFieldName
    ? new RegExp(`"\\s*,\\s*"${nextFieldName}"\\s*:`)
    : /"\s*[,}]?\s*$/;
  const restText = rawAnswer.slice(valueStartIndex);
  const endMatch = valueEndPattern.exec(restText);

  if (!endMatch) {
    return undefined;
  }

  return restText
    .slice(0, endMatch.index)
    .replace(/\\"/g, "\"")
    .trim();
}

function extractJsonLikePoints(rawAnswer: string): string[] {
  const pointsMatch = rawAnswer.match(/"points"\s*:\s*\[([\s\S]*?)\]\s*,\s*"next_question"\s*:/);
  const pointsBlock = pointsMatch?.[1];

  if (!pointsBlock) {
    return [];
  }

  return pointsBlock
    .split(/\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^"/, "")
        .replace(/",?$/, "")
        .replace(/\\"/g, "\"")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 5);
}

function buildFallbackStructuredAnswer(rawAnswer: string): ChatResponseBody {
  const title = extractJsonLikeField(rawAnswer, "title", "summary") || "AI 回答";
  const summary =
    extractJsonLikeField(rawAnswer, "summary", "points") ||
    cleanupRawAnswerForDisplay(rawAnswer) ||
    "AI 返回了空内容，请稍后再试。";
  const points = extractJsonLikePoints(rawAnswer);
  const nextQuestion =
    extractJsonLikeField(rawAnswer, "next_question") || "你想换一种方式再问一次吗？";

  return {
    title,
    summary,
    points,
    next_question: nextQuestion,
  };
}

/**
 * 把 AI 原始文本转换成结构化响应。
 *
 * 如果解析失败，会尽量从“像 JSON 的文本”里提取字段，
 * 避免 iOS 因为模型格式偶发错误而拿不到固定结构。
 */
export function parseStructuredAnswer(rawAnswer: string): ChatResponseBody {
  try {
    const jsonText = extractJsonText(rawAnswer);
    const parsed = JSON.parse(jsonText);

    return normalizeStructuredAnswer(parsed, rawAnswer);
  } catch (error) {
    console.warn("Failed to parse structured AI response:", error);
    return buildFallbackStructuredAnswer(rawAnswer);
  }
}
