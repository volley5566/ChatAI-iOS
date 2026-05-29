import { Embeddings } from "@langchain/core/embeddings";
import { OllamaEmbeddings } from "@langchain/ollama";
import {
  embeddingsProvider,
  ollamaBaseUrl,
  ollamaEmbeddingModel,
} from "../config/env";
import { LocalKeywordEmbeddings } from "./localEmbeddings";

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/embeddings.ts — Embeddings 工厂(可切换 provider)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   ragRetriever.ts 调 createLangChainEmbeddings() 拿到向量化器,
 *   用来给文档/查询计算 embedding 向量。
 *
 * # 为什么单独抽工厂
 *   RAG 里最容易替换、也最应该隔离的部分就是 embeddings:
 *     - 学习 / 本地调试    → LocalKeywordEmbeddings(零配置跑通链路)
 *     - 默认               → Ollama 本地服务,nomic-embed-text 真 768 维语义向量
 *     - 生产 / 更高质量    → 可以换 OpenAI / bge / jina / Voyage 等
 *   上层 retriever 不直接 new,统一调这里——换 provider 不用改 MCP / HTTP / iOS。
 *
 * # 返回 base 类 Embeddings 不是具体子类
 *   调用方拿到的只是"一个能 embedQuery / embedDocuments 的东西",
 *   内部是 Ollama 还是 local-keyword 完全无感——这就是依赖倒置。
 */

/**
 * 当前 embedding 配置的稳定标识(给 ragCache 的指纹用)。
 *
 * 切换 provider 或 Ollama 模型,标识就变,缓存自动失效。
 *
 * 格式约定:
 *   ollama:<model_name>     例如 "ollama:nomic-embed-text"
 *   local-keyword           hash 伪向量没"模型"概念,直接用 provider 名
 *
 * 用 getter 函数(而不是 export 常量),是为了让上层调用时显式取"当前值",
 * 和环境变量惰性加载的语义一致。
 */
export function getEmbeddingsIdentity(): string {
  switch (embeddingsProvider) {
    case "ollama":
      return `ollama:${ollamaEmbeddingModel}`;
    case "local-keyword":
    case "local":
      return "local-keyword";
    default:
      return embeddingsProvider;
  }
}

export function createLangChainEmbeddings(): Embeddings {
  switch (embeddingsProvider) {
    case "ollama":
      /**
       * Ollama 真 embedding。
       *
       *   model    从 env 读,默认 nomic-embed-text(768 维多语言)
       *   baseUrl  默认 http://localhost:11434,远程部署时可改
       *
       * 第一次调用 embedQuery / embedDocuments 时,Ollama 会按需把模型加载进内存
       * (默认 keepAlive=5 分钟,5 分钟没人用就卸载,下次再用重新加载)。
       * 加载耗时 0.5-1s,之后每次 embedding 调用 30-80ms。
       *
       * OllamaEmbeddings 的接口和 OpenAIEmbeddings 完全一致——
       * embedQuery(text) / embedDocuments(texts[]) 是 LangChain Embeddings 抽象类
       * 强制规定的,换任何 provider 上层代码都不用改。
       */
      return new OllamaEmbeddings({
        model: ollamaEmbeddingModel,
        baseUrl: ollamaBaseUrl,
      });

    case "local-keyword":
    case "local":
      /**
       * Hash 伪向量,保留下来主要给:
       * - 没装 Ollama 但想看 RAG 流程跑通的人
       * - 离线 / CI 环境
       *
       * 注意它不是"真" embedding,只是结构上跑通 LangChain 链路。
       */
      return new LocalKeywordEmbeddings();

    default:
      throw new Error(
        `Unsupported EMBEDDINGS_PROVIDER: ${embeddingsProvider}. ` +
          "Supported: ollama, local-keyword."
      );
  }
}
