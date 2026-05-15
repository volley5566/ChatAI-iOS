/**
 * 它把角色说明、RAG context、输出格式规则拼起来
 *
 * 结构化接口使用的输出规则。
 */
export const structuredOutputGuide = `
You must return only valid JSON.
Do not return Markdown.
Do not wrap the JSON in code fences.
Do not add any text before or after the JSON.

The JSON must match this exact shape:
{
  "title": "A short title in the user's language",
  "summary": "A clear short summary in the user's language",
  "points": [
    "Key point 1",
    "Key point 2",
    "Key point 3"
  ],
  "next_question": "A helpful follow-up question in the user's language"
}

Rules:
- title must be short.
- summary must be beginner-friendly.
- points must contain 2 to 5 short items.
- next_question must guide the user to continue learning.
- All string values must be valid JSON strings.
- If you mention code that contains double quotes, escape the quotes or rewrite the example without double quotes.
- Do not put a JSON example inside any string value.
`;

/**
 * 普通流式接口使用的回答规则。
 */
export const streamingOutputGuide = `
Return a normal conversational answer, not JSON.
Do not wrap the whole answer in a JSON object.
Do not mention that you are streaming.
Keep the answer beginner-friendly and practical.
If code helps, include a short code example.
Use the same language as the user's question.
`;

/**
 * Agent 接口使用的额外规则。
 */
export const agentOutputGuide = `
You are an iOS learning assistant agent.

You can use tools when they help:
- Use searchKnowledge when the user asks about iOS, SwiftUI, this project, backend code, RAG, streaming, or a concept that may exist in the local knowledge base.
- Use generateQuiz when the user asks for exercises, practice questions, quizzes, review questions, or wants to test understanding.

Tool rules:
- Do not claim you used a tool unless a tool result is present.
- If a tool returns no useful result, say that clearly and continue with general beginner-friendly guidance.
- Do not invent source file names or knowledge base content.
- For final answers, write normal conversational text, not JSON.
- Use the same language as the user's question.
`;

const defaultRolePrompt =
  "You are a helpful AI assistant. Explain concepts clearly and simply for a mobile developer learning iOS, SwiftUI, and AI application development.";

export function buildRolePrompt(systemPrompt?: string): string {
  return systemPrompt || defaultRolePrompt;
}

/**
 * 生成 RAG 提示词。
 */
export function buildRagGuide(knowledgeContext?: string): string {
  return knowledgeContext
    ? `
Use the following knowledge base context as the primary reference.
If the context is relevant, base your answer on it.
If the context is not enough, you may add general knowledge, but keep the answer beginner-friendly.

Knowledge base context:
${knowledgeContext}
`
    : `
No matching knowledge base context was found for this question.
Answer with your general knowledge, but keep the answer beginner-friendly.
`;
}

export function buildInstructions(
  systemPrompt?: string,
  knowledgeContext?: string
): string {
  const rolePrompt = buildRolePrompt(systemPrompt);
  const ragGuide = buildRagGuide(knowledgeContext);

  return `${rolePrompt}\n\n${ragGuide}\n\n${structuredOutputGuide}`;
}

export function buildStreamingInstructions(
  systemPrompt?: string,
  knowledgeContext?: string
): string {
  const rolePrompt = buildRolePrompt(systemPrompt);
  const ragGuide = buildRagGuide(knowledgeContext);

  return `${rolePrompt}\n\n${ragGuide}\n\n${streamingOutputGuide}`;
}

/**
 * Agent 不把 RAG context 固定塞进 system prompt，
 * 而是把“搜索知识库”暴露为工具，让模型自己决定是否调用。
 */
export function buildAgentInstructions(systemPrompt?: string): string {
  const rolePrompt = buildRolePrompt(systemPrompt);

  return `${rolePrompt}\n\n${agentOutputGuide}`;
}
