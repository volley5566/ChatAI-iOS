# AI iOS Chat Demo 项目架构

Keywords: iOS, SwiftUI, Node.js, Express, backend, API, DeepSeek, OpenAI-compatible, architecture

这个项目是一个前后端分离的 AI 聊天 Demo。

它包含两个主要部分：

- iOS App：负责界面、输入、展示 AI 回答
- Node.js 后端：负责保护 API Key、调用 AI 模型、整理响应格式

## 调用流程

```text
用户在 iOS 输入问题
  -> SwiftUI 调用 ChatViewModel
  -> ChatViewModel 调用 ChatAPIClient
  -> ChatAPIClient POST /api/chat
  -> Node.js Express 接收请求
  -> Node.js 调用 DeepSeek API
  -> Node.js 把 AI 回答整理成结构化 JSON
  -> iOS 解码 JSON
  -> SwiftUI 展示标题、摘要、重点、下一步问题
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
- 解析后端返回的 JSON
- 展示结构化回答

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
- 将 AI 输出整理成稳定 JSON

核心文件：

- `backend-node/src/server.ts`

