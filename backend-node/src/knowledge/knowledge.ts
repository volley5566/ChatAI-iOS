import fs from "fs";
import path from "path";
import type { KnowledgeDocument, ScoredKnowledgeDocument } from "../shared/types";

/**
 * knowledgeDirectory 是知识库目录。
 *
 * 开发环境下 __dirname 是 backend-node/src/knowledge，
 * 编译后 __dirname 是 backend-node/dist/knowledge。
 *
 * 两种情况下 ../../knowledge 都指向 backend-node/knowledge。
 * 这里故意不把知识库放进 src，避免 Markdown 文档和 TypeScript 源码混在一起。
 */
const knowledgeDirectory = path.resolve(__dirname, "../../knowledge");

const maxKnowledgeDocuments = 3;
const minKnowledgeScore = 20;
const maxCharactersPerDocument = 2600;
const maxKnowledgeContextCharacters = 7000;

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "what",
  "why",
  "how",
  "this",
  "that",
  "is",
  "are",
  "was",
  "were",
  "什么",
  "怎么",
  "如何",
  "为什么",
  "这个",
  "那个",
  "区别",
]);

function extractMarkdownTitle(content: string): string | undefined {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return titleMatch?.[1]?.trim();
}

function extractMarkdownKeywords(content: string): string[] {
  const keywordsMatch = content.match(/^Keywords:\s*(.+)$/im);
  const keywordsText = keywordsMatch?.[1];

  if (!keywordsText) {
    return [];
  }

  return keywordsText
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

/**
 * 读取 knowledge 目录中的 Markdown 文件。
 */
function loadKnowledgeDocuments(): KnowledgeDocument[] {
  if (!fs.existsSync(knowledgeDirectory)) {
    console.warn(`Knowledge directory not found: ${knowledgeDirectory}`);
    return [];
  }

  const markdownFiles = fs
    .readdirSync(knowledgeDirectory)
    .filter((fileName) => fileName.endsWith(".md"))
    .filter((fileName) => fileName.toLowerCase() !== "readme.md")
    .sort();

  return markdownFiles.map((fileName) => {
    const filePath = path.join(knowledgeDirectory, fileName);
    const content = fs.readFileSync(filePath, "utf8");
    const title = extractMarkdownTitle(content) || fileName;
    const keywords = extractMarkdownKeywords(content);

    return {
      fileName,
      title,
      keywords,
      content,
    };
  });
}

function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizeForSearch(text: string): string[] {
  const normalizedText = normalizeForSearch(text);
  const matches =
    normalizedText.match(/[@#]?[a-z0-9_+.-]+|[\u4e00-\u9fff]{2,}/g) || [];

  return Array.from(
    new Set(
      matches
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .filter((term) => !stopWords.has(term))
    )
  );
}

function scoreKnowledgeDocument(
  question: string,
  document: KnowledgeDocument
): number {
  const questionText = normalizeForSearch(question);
  const titleText = normalizeForSearch(document.title);
  const contentText = normalizeForSearch(document.content);
  const keywordTexts = document.keywords.map(normalizeForSearch);
  const queryTerms = tokenizeForSearch(question);

  let score = 0;

  for (const keyword of keywordTexts) {
    if (keyword && questionText.includes(keyword)) {
      score += 20;
    }
  }

  for (const term of queryTerms) {
    if (titleText.includes(term)) {
      score += 12;
    }

    if (keywordTexts.some((keyword) => keyword.includes(term) || term.includes(keyword))) {
      score += 16;
    }

    if (contentText.includes(term)) {
      score += term.startsWith("@") ? 6 : 3;
    }
  }

  return score;
}

const knowledgeDocuments = loadKnowledgeDocuments();

console.error(
  `Loaded ${knowledgeDocuments.length} knowledge documents from ${knowledgeDirectory}`
);

/**
 * 根据用户问题检索最相关的知识库文档。
 */
export function retrieveRelevantKnowledge(question: string): ScoredKnowledgeDocument[] {
  return knowledgeDocuments
    .map((document) => ({
      document,
      score: scoreKnowledgeDocument(question, document),
    }))
    .filter((item) => item.score >= minKnowledgeScore)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.document.fileName.localeCompare(b.document.fileName);
    })
    .slice(0, maxKnowledgeDocuments);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...`;
}

/**
 * 把检索到的 Markdown 文档整理成 prompt 里的 context。
 */
export function buildKnowledgeContext(
  matches: ScoredKnowledgeDocument[]
): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  let context = "";

  for (const match of matches) {
    const nextBlock = `
[Source: ${match.document.fileName}]
[Title: ${match.document.title}]
[Relevance score: ${match.score}]

${truncateText(match.document.content, maxCharactersPerDocument)}
`;

    if ((context + nextBlock).length > maxKnowledgeContextCharacters) {
      break;
    }

    context += nextBlock;
  }

  return context.trim();
}
