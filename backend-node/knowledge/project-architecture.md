# AI iOS Chat Demo 项目架构

Keywords: iOS, SwiftUI, Node.js, Express, backend, API, DeepSeek, OpenAI-compatible, architecture, Tool Calling, Agent, SSE, streaming

这个项目是一个前后端分离的 AI 聊天 Demo。

它包含两个主要部分：

- iOS App：负责界面、输入、展示 AI 回答
- Node.js 后端：负责保护 API Key、调用 AI 模型、整理响应格式

## 调用流程

当前 App 默认走 Agent 流式接口：

```text
用户在 iOS 输入问题
  -> SwiftUI 调用 ChatViewModel
  -> ChatViewModel 调用 ChatAPIClient
  -> ChatAPIClient POST /api/agent/stream
  -> Node.js Express 接收请求
  -> Node.js 把工具列表交给 DeepSeek/OpenAI-compatible API
  -> 模型决定是否返回 tool_call
  -> Node.js 校验工具名和参数
  -> Node.js 执行本地工具
  -> Node.js 把工具结果交回模型
  -> 模型生成最终回答
  -> Node.js 通过 SSE 流式返回文本片段
  -> iOS 实时更新同一条 AI 消息气泡
```

项目里也保留了两个旧接口：

```text
POST /api/chat
  -> 非流式结构化 JSON 回答

POST /api/chat/stream
  -> 固定 RAG 检索 + 普通流式文本回答
```

## 为什么需要 Node.js 后端

iOS App 不应该直接保存大模型 API Key。

如果把 API Key 写进 App，别人可以通过反编译、抓包或调试拿到它。
拿到 Key 后，就可能用你的额度发起请求。

所以更推荐：

```text
iOS App
  -> 自己的 Node.js 后端
  -> AI 服务商 API
```

## iOS 侧职责

iOS 负责：

- 展示聊天页面
- 管理用户输入
- 调用后端接口
- 解析后端 SSE 事件
- 展示 Agent 工具执行状态
- 把流式 delta 追加到同一条 assistant 消息里
- 在需要时仍可解析旧结构化接口的 JSON

核心文件：

- `ContentView.swift`
- `ChatViewModel.swift`
- `ChatAPIClient.swift`
- `StructuredAnswer.swift`
- `StructuredAnswerView.swift`

## Node.js 侧职责

Node.js 负责：

- 读取 `.env` 里的 API Key
- 接收 iOS 请求
- 调用 DeepSeek/OpenAI-compatible API
- 控制 prompt
- 维护可用工具列表
- 校验模型返回的 tool_call 参数
- 执行真正的后端工具
- 通过 SSE 返回 tool_start / tool_done 工具状态
- 通过 SSE 返回最终流式文本
- 在旧结构化接口中将 AI 输出整理成稳定 JSON

当前 Agent 支持两个本地工具：

```text
searchKnowledge(query)
  搜索 backend-node/knowledge/ 里的 Markdown 知识库

generateQuiz(topic, count)
  根据学习主题生成 1 到 5 道练习题
```

## Tool Calling 在本项目中的含义

Tool Calling 不是模型直接执行代码。

模型只负责返回一个结构化的工具调用请求，例如：

```text
调用 searchKnowledge
参数 query = "SwiftUI @State"
```

真正执行工具的是 Node.js 后端。

这样可以把职责分开：

- 模型负责理解用户意图、选择工具、组织最终回答
- 后端负责校验工具名、校验参数、执行真实函数、控制安全边界

当前工具都只读或只生成练习题，不会修改数据库，也不会调用支付、订单等高风险系统。

## Agent 执行过程可视化

Agent 接口除了最终回答的 `delta` 事件，还会返回工具状态事件：

```text
tool_start
  表示后端开始执行某个工具，例如“正在查询知识库”

tool_done
  表示工具执行完成，例如“已查询知识库，找到 2 条相关资料”
```

iOS 不会把这些状态显示成新的聊天消息。

它会把状态挂在当前 assistant 气泡里，这样用户能看到 AI 的执行过程，
同时聊天列表仍然保持一问一答的结构。

核心文件：

- `backend-node/src/server.ts`
