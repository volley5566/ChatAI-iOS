import path from "path";
import { Document } from "@langchain/core/documents";
import { DirectoryLoader } from "@langchain/classic/document_loaders/fs/directory";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";

/**
 * LangChain Document metadata。
 *
 * LangChain 的 Document 本身只有两个核心字段：
 * - pageContent：真正给 splitter / embedding / model 使用的文本
 * - metadata：和这段文本绑定的结构化信息
 *
 * 这里把项目原来的 source/title/keywords/citation 思路放进 metadata。
 * 好处是：文档经过 splitter 切成 chunk 后，metadata 会跟着 chunk 一起走，
 * 最终检索命中时仍然知道它来自哪个文件、哪个主题。
 */
export type KnowledgeDocumentMetadata = {
  source: string;
  fileName: string;
  title: string;
  keywords: string[];
};

/**
 * 知识库目录。
 *
 * 开发环境：
 *   __dirname = backend-node/src/langchain
 *
 * 编译后：
 *   __dirname = backend-node/dist/langchain
 *
 * 两种情况下 ../../knowledge 都指向 backend-node/knowledge。
 */
export const knowledgeDirectory = path.resolve(__dirname, "../../knowledge");

export async function loadKnowledgeDocuments(): Promise<
  Document<KnowledgeDocumentMetadata>[]
> {
  /**
   * DirectoryLoader / TextLoader 是 LangChain 的 Document Loader。
   *
   * 这一层只负责“把外部资料读成 Document”，不负责切 chunk、不负责 embedding。
   * 把这些步骤拆开，你后续调试 RAG 时会很清楚：
   * - Loader 出问题：文档没读到
   * - Splitter 出问题：chunk 切得不好
   * - Embedding 出问题：检索不准
   */
  const loader = new DirectoryLoader(
    knowledgeDirectory,
    {
      ".md": (filePath: string) => new TextLoader(filePath),
    },
    false,
    "ignore"
  );

  const rawDocuments = await loader.load();

  return rawDocuments
    .filter((document) => {
      const fileName = getFileNameFromDocument(document);
      return fileName.toLowerCase() !== "readme.md";
    })
    .sort((a, b) => {
      return getFileNameFromDocument(a).localeCompare(getFileNameFromDocument(b));
    })
    .map((document) => {
      const source = getSourceFromDocument(document);
      const fileName = path.basename(source);
      const pageContent = removeMetadataLines(document.pageContent);
      const title = extractMarkdownTitle(pageContent) || fileName;
      const keywords = extractMarkdownKeywords(document.pageContent);

      return new Document<KnowledgeDocumentMetadata>({
        pageContent,
        metadata: {
          source,
          fileName,
          title,
          keywords,
        },
      });
    });
}

function getSourceFromDocument(document: Document): string {
  const source = document.metadata.source;

  if (typeof source === "string" && source.trim()) {
    return source;
  }

  return "unknown.md";
}

function getFileNameFromDocument(document: Document): string {
  return path.basename(getSourceFromDocument(document));
}

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

function removeMetadataLines(content: string): string {
  /**
   * Keywords 是给检索和调试用的 metadata。
   * 它不应该作为正文塞给模型，否则模型可能在回答里复述
   * “Keywords: ...” 这种维护字段。
   */
  return content
    .split(/\r?\n/)
    .filter((line) => !/^Keywords:\s*/i.test(line.trim()))
    .join("\n")
    .trim();
}
