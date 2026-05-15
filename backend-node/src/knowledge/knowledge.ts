import fs from "fs";
import path from "path";
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  ScoredKnowledgeChunk,
} from "../shared/types";

/**
 * 本地 Markdown 知识库检索模块。
 *
 * 这一版仍然是“学习版 RAG”，没有接 embedding / vector store。
 * 但它已经从“整篇文档检索”升级成“Markdown chunk 检索”：
 *
 * 1. 启动时读取 backend-node/knowledge 里的 Markdown 文件
 * 2. 每篇 Markdown 按标题切成多个 KnowledgeChunk
 * 3. 用户提问时，对 chunk 做关键词打分
 * 4. 返回最相关的 chunk，并附带 source / section / citation
 *
 * 这样后续接 LangChain 或向量数据库时，可以保留 KnowledgeChunk 结构，
 * 只把“关键词打分”替换成“embedding + 向量相似度检索”。
 */

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

/**
 * 返回给模型的 chunk 数量。
 *
 * chunk 比整篇文档更小，所以可以多取几段；
 * 但仍然要控制数量，避免把太多上下文塞进 prompt。
 */
const maxKnowledgeChunks = 5;
const minKnowledgeScore = 12;
const maxCharactersPerChunk = 1600;
const maxKnowledgeContextCharacters = 7000;

/**
 * 单个 Markdown 标题小节太长时，继续按段落拆分。
 *
 * 这不是 embedding 时代的 token splitter，只是一个简单保护：
 * 防止某个超长小节独占全部 context。
 */
const maxRawChunkCharacters = 2200;

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

type MarkdownHeading = {
  level: number;
  text: string;
};

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

function parseMarkdownHeading(line: string): MarkdownHeading | undefined {
  /**
   * 识别 Markdown 标题：
   *   # 一级标题
   *   ## 二级标题
   *   ### 三级标题
   *
   * 当前 chunk 策略就是“遇到标题就开始一个新 chunk”。
   * 这比固定每 N 个字符切一刀更适合学习文档，因为标题天然代表语义边界。
   */
  const match = line.match(/^(#{1,6})\s+(.+)$/);

  if (!match) {
    return undefined;
  }

  return {
    level: match[1].length,
    text: match[2].trim(),
  };
}

function isMetadataLine(line: string): boolean {
  /**
   * Keywords 是给检索打分用的 metadata，不需要重复放进 chunk content。
   * 否则模型最后回答时可能把 "Keywords: ..." 当正文引用。
   */
  return /^Keywords:\s*/i.test(line.trim());
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start].trim()) {
    start += 1;
  }

  while (end > start && !lines[end - 1].trim()) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function buildSectionPath(headingStack: string[], fallbackTitle: string): string {
  /**
   * headingStack 会保留当前标题路径。
   *
   * 例如：
   *   # SwiftUI @State
   *   ## 注意事项
   *
   * section 会变成：
   *   SwiftUI @State / 注意事项
   *
   * 这个 section 会进入 citation，方便最终回答展示“参考来源”。
   */
  const sectionPath = headingStack.filter(Boolean).join(" / ");
  return sectionPath || fallbackTitle;
}

function splitLongChunkContent(content: string): string[] {
  if (content.length <= maxRawChunkCharacters) {
    return [content];
  }

  /**
   * 如果一个标题下面内容特别长，优先按空行拆段。
   * 这样比按字符硬切更不容易把代码块或一句话切碎。
   */
  const paragraphs = content.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;

    if (next.length <= maxRawChunkCharacters) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (paragraph.length <= maxRawChunkCharacters) {
      current = paragraph;
      continue;
    }

    /**
     * 极端情况：单个段落仍然很长。
     * 这里才按字符硬切，作为最后的保护网。
     */
    for (let index = 0; index < paragraph.length; index += maxRawChunkCharacters) {
      chunks.push(paragraph.slice(index, index + maxRawChunkCharacters));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function buildKnowledgeChunks(document: KnowledgeDocument): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const lines = document.content.split(/\r?\n/);
  const headingStack: string[] = [];
  let currentSection = document.title;
  let currentLines: string[] = [];

  const flushCurrentChunk = () => {
    const trimmedLines = trimBlankLines(currentLines);

    if (trimmedLines.length === 0) {
      currentLines = [];
      return;
    }

    const rawContent = trimmedLines.join("\n").trim();
    const contentParts = splitLongChunkContent(rawContent);

    for (const [partIndex, content] of contentParts.entries()) {
      const section =
        contentParts.length > 1
          ? `${currentSection} / Part ${partIndex + 1}`
          : currentSection;

      chunks.push({
        id: `${document.fileName}#chunk-${chunks.length + 1}`,
        fileName: document.fileName,
        title: document.title,
        section,
        citation: `${section} (${document.fileName})`,
        keywords: document.keywords,
        content,
      });
    }

    currentLines = [];
  };

  for (const line of lines) {
    const heading = parseMarkdownHeading(line);

    if (heading) {
      flushCurrentChunk();

      /**
       * 更新标题路径。
       *
       * 如果遇到二级标题，就保留一级标题并替换二级标题；
       * 如果遇到三级标题，就保留一级/二级标题并替换三级标题。
       */
      headingStack[heading.level - 1] = heading.text;
      headingStack.length = heading.level;
      currentSection = buildSectionPath(headingStack, document.title);
      currentLines = [line];
      continue;
    }

    if (isMetadataLine(line)) {
      continue;
    }

    currentLines.push(line);
  }

  flushCurrentChunk();

  /**
   * 如果某篇 Markdown 没有任何标题，也不要丢掉它。
   * 这种情况下整篇文档就是一个 chunk。
   */
  if (chunks.length === 0 && document.content.trim()) {
    const content = document.content
      .split(/\r?\n/)
      .filter((line) => !isMetadataLine(line))
      .join("\n")
      .trim();

    chunks.push({
      id: `${document.fileName}#chunk-1`,
      fileName: document.fileName,
      title: document.title,
      section: document.title,
      citation: `${document.title} (${document.fileName})`,
      keywords: document.keywords,
      content,
    });
  }

  return chunks;
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

function scoreKnowledgeChunk(question: string, chunk: KnowledgeChunk): number {
  /**
   * 这是关键词版 chunk scoring。
   *
   * 它不理解“语义相似度”，只是用可解释的规则打分：
   * - 用户问题直接包含文档 keyword，加分最高
   * - 命中 section，比只命中正文更重要
   * - 命中 title / keyword，比普通正文更重要
   * - 命中正文也加分，但权重低一些
   *
   * 未来换向量检索时，可以保留 retrieveRelevantKnowledge 的输出结构，
   * 把这个函数替换成 embedding similarity score。
   */
  const questionText = normalizeForSearch(question);
  const titleText = normalizeForSearch(chunk.title);
  const sectionText = normalizeForSearch(chunk.section);
  const contentText = normalizeForSearch(chunk.content);
  const keywordTexts = chunk.keywords.map(normalizeForSearch);
  const queryTerms = tokenizeForSearch(question);

  let score = 0;

  for (const keyword of keywordTexts) {
    if (keyword && questionText.includes(keyword)) {
      score += 24;
    }
  }

  for (const term of queryTerms) {
    if (titleText.includes(term)) {
      score += 10;
    }

    if (sectionText.includes(term)) {
      score += 14;
    }

    if (keywordTexts.some((keyword) => keyword.includes(term) || term.includes(keyword))) {
      score += 18;
    }

    if (contentText.includes(term)) {
      score += term.startsWith("@") ? 7 : 3;
    }
  }

  return score;
}

const knowledgeDocuments = loadKnowledgeDocuments();
const knowledgeChunks = knowledgeDocuments.flatMap(buildKnowledgeChunks);

console.error(
  `Loaded ${knowledgeDocuments.length} knowledge documents and ${knowledgeChunks.length} chunks from ${knowledgeDirectory}`
);

/**
 * 根据用户问题检索最相关的知识库 chunk。
 *
 * 函数名暂时保留 retrieveRelevantKnowledge，是为了不让上层调用方关心
 * “底层到底按文档检索还是按 chunk 检索”。
 */
export function retrieveRelevantKnowledge(question: string): ScoredKnowledgeChunk[] {
  return knowledgeChunks
    .map((chunk) => ({
      chunk,
      score: scoreKnowledgeChunk(question, chunk),
    }))
    .filter((item) => item.score >= minKnowledgeScore)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.chunk.citation.localeCompare(b.chunk.citation);
    })
    .slice(0, maxKnowledgeChunks);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...`;
}

/**
 * 把检索到的 Markdown chunks 整理成 prompt 里的 context。
 */
export function buildKnowledgeContext(
  matches: ScoredKnowledgeChunk[]
): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  let context = "";

  for (const match of matches) {
    const nextBlock = `
[Source: ${match.chunk.fileName}]
[Title: ${match.chunk.title}]
[Section: ${match.chunk.section}]
[Citation: ${match.chunk.citation}]
[Relevance score: ${match.score}]

${truncateText(match.chunk.content, maxCharactersPerChunk)}
`;

    if ((context + nextBlock).length > maxKnowledgeContextCharacters) {
      break;
    }

    context += nextBlock;
  }

  return context.trim();
}
