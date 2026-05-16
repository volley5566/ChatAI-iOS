import { embeddingsProvider } from "../config/env";
import { LocalKeywordEmbeddings } from "./localEmbeddings";

/**
 * LangChain embeddings 工厂。
 *
 * RAG 里最容易替换、也最应该隔离的部分就是 embeddings：
 * - 学习 / 本地调试：可以用 LocalKeywordEmbeddings，零配置跑通完整链路
 * - 生产 / 更高质量：可以换成 OpenAI、bge、jina、Voyage、本地模型服务等
 *
 * 上层 retriever 不直接 new 某个 embedding 类，而是统一调用这个工厂。
 * 这样将来换 embedding provider 时，不需要去改 MCP、HTTP route 或 iOS。
 */
export function createLangChainEmbeddings(): LocalKeywordEmbeddings {
  switch (embeddingsProvider) {
    case "local-keyword":
    case "local":
      return new LocalKeywordEmbeddings();

    default:
      throw new Error(
        `Unsupported EMBEDDINGS_PROVIDER: ${embeddingsProvider}. ` +
          "Current learning build supports local-keyword."
      );
  }
}
