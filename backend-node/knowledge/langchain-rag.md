# LangChain RAG 原理

Keywords: RAG, retrieval augmented generation, embedding, vector store, semantic search, similarity, cosine, chunk, splitter, retriever, knowledge base, 检索, 向量, 语义检索, 知识库, Ollama, nomic-embed-text

RAG 全称 Retrieval-Augmented Generation，意思是"检索增强生成"。它解决的核心问题是：**大语言模型不知道你的私有知识**。

## 为什么需要 RAG

LLM 的训练数据有截止日期，且不包含你公司或个人的私有资料。直接问 GPT "我们项目的架构是什么"，它只能瞎编。

最朴素的解决方案是把所有资料塞进 prompt：

```text
[这是我们项目的全部文档：...10 万字...]
用户问题：项目用了什么数据库？
```

但 token 既贵又有上限，而且无关内容多了反而拉低回答质量。

RAG 的思路是：**先从资料里挑出最相关的几段，再让 LLM 基于这几段回答**。

## RAG 完整流程

```text
[1] 离线建索引
  Markdown 文档
       |
       v
  Splitter 切成 chunk
       |
       v
  每个 chunk 用 embedding 模型变成向量
       |
       v
  存进 Vector Store

[2] 在线查询
  用户问题
       |
       v
  同一个 embedding 模型变成查询向量
       |
       v
  在 Vector Store 里用 cosine similarity 找最近的 K 个 chunk
       |
       v
  把这 K 个 chunk + 用户问题一起喂给 LLM
       |
       v
  LLM 基于这些资料回答
```

关键点：**建索引时和查询时必须用同一个 embedding 模型**，否则向量空间不一致，相似度计算没有意义。

## Embedding 模型

Embedding 模型的输入是一段文本，输出是一个固定维度的向量（通常 384、768、1024、1536 维）：

```text
"SwiftUI 状态管理" -> [0.12, -0.45, 0.78, ..., 0.03]
```

好的 embedding 模型的核心特性是：**语义相近的文本，向量距离近**。

- "SwiftUI 状态管理" 和 "@State 怎么用" 字面没一个字相同，但向量很接近
- "SwiftUI 状态管理" 和 "Node.js 数据库" 没有语义关联，向量很远

这种"理解意思而非字符"的能力，来自 embedding 模型在几十亿对句子上的预训练。

## 常见 embedding 选择

| 模型 | 维度 | 部署方式 | 特点 |
|------|------|----------|------|
| OpenAI text-embedding-3-small | 1536 | 云 API | 质量最高，付费 |
| Ollama nomic-embed-text | 768 | 本地 | 免费，中英文都强 |
| BGE-M3 | 1024 | 本地 | 多语言+长文档+稀疏向量 |
| Voyage AI | 1024 | 云 API | 检索专精，质量稳定 |

学习项目和隐私敏感场景推荐 Ollama 本地方案，零成本零依赖。

## Vector Store

Vector Store 是向量数据库，提供两个核心能力：

1. **存向量**：把 chunk 的向量持久化
2. **查最近的 K 个**：给一个查询向量，返回最相似的 K 个

LangChain 支持的 Vector Store 有几十种：

- **MemoryVectorStore**：内存版，启动即用，重启丢失。适合学习
- **HNSWLib**：本地磁盘，C++ 实现的 HNSW 算法，速度快
- **Chroma / Qdrant / Weaviate**：独立服务，适合生产
- **pgvector**：PostgreSQL 扩展，已有 PG 时直接用

接口都被 LangChain 统一抽象成 `VectorStore` 类，换实现不用改业务代码。

## Splitter：把文档切成 chunk

为什么不能把整篇 Markdown 当成一个向量？

- Embedding 模型有 token 上限（通常 512-8192）
- 一篇长文档的"语义"是模糊的，向量化后丢失细节
- 检索时只想返回"最相关的几段"，不是"最相关的整篇文档"

LangChain 的 `RecursiveCharacterTextSplitter` 是最常用的切分器：

```typescript
const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
  chunkSize: 1200,     // 每个 chunk 目标字符数
  chunkOverlap: 160,   // 相邻 chunk 重叠字符
});
```

`fromLanguage("markdown")` 会按 Markdown 的语义边界（标题 > 段落 > 句子 > 字符）逐级切，比"每 N 字符硬切"质量好得多。

`chunkOverlap` 让相邻 chunk 有重叠，避免重要信息正好被切在两个 chunk 之间。

## 相似度阈值（minSimilarity）

检索返回的每个结果都有 score（cosine similarity，0 到 1 之间）。score 太低说明"勉强凑数的不相关结果"，不如不要：

```typescript
const results = await store.similaritySearchWithScore(query, topK);
return results.filter(([, score]) => score >= MIN_SIMILARITY);
```

阈值要根据具体 embedding 模型实测调。`nomic-embed-text` 一般 0.4 以上才算有意义的命中。

## RAG 调优要点

效果不好时按这个顺序排查：

1. **Splitter**：chunk 是不是切得太碎或太大，重要信息被截断
2. **Embedding 模型**：换更强的模型（比如从 hash 伪向量切到 Ollama 真模型）
3. **Top K**：找回的数量是否合适（一般 3-8）
4. **相似度阈值**：是否过滤掉了好结果或留了太多噪音
5. **Prompt**：检索到的资料怎么塞给 LLM，影响很大
