# Knowledge Base

这个目录用于存放 RAG 知识库文档。

RAG 的意思是：

```text
用户提问
  -> 后端先从这些 Markdown 文档里查找相关资料
  -> 把相关资料和用户问题一起发送给 AI
  -> AI 基于资料生成回答
```

第一版先使用简单的 Markdown 文件，不引入向量数据库。

推荐每篇文档都包含：

- `# 标题`
- `Keywords`：方便后端做关键词匹配
- 简短、明确的正文
- 适合初学者的例子

当前文档：

- `project-architecture.md`：当前项目的整体架构
- `swiftui-state.md`：SwiftUI `@State`
- `swiftui-binding.md`：SwiftUI `@Binding`
- `ios-networking-urlsession.md`：iOS 使用 `URLSession` 请求后端
- `structured-output.md`：Prompt 和结构化输出

