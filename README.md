# AI iOS Chat Demo

一个用于学习的 AI 聊天 Demo，包含：

- `ios/ChatAI-iOS`：SwiftUI iOS App
- `backend-node`：Node.js + Express 后端

调用流程：

```text
iOS SwiftUI
  -> Node.js /api/chat/stream
  -> DeepSeek OpenAI-compatible API stream
  -> Node.js 通过 SSE 返回文本片段
  -> iOS 实时更新同一条 AI 消息气泡
```

项目里也保留了非流式结构化接口 `/api/chat`，
方便后续继续做“最终结构化卡片”或接口对比测试。

## 1. 启动后端

先进入后端目录：

```bash
cd backend-node
```

复制环境变量示例文件：

```bash
cp .env.example .env
```

然后在 `.env` 里填入你的真实 `DEEPSEEK_API_KEY`。

安装依赖：

```bash
npm install
```

启动开发服务：

```bash
npm run dev
```

后端默认地址：

```text
http://127.0.0.1:8000
```

健康检查：

```bash
curl http://127.0.0.1:8000/health
```

## 2. 运行 iOS App

用 Xcode 打开：

```text
ios/ChatAI-iOS/ChatAI-iOS.xcodeproj
```

选择 iOS 模拟器运行即可。

iOS 端后端地址配置在：

```text
ios/ChatAI-iOS/ChatAI-iOS/Core/AppConfig.swift
```

模拟器调试时可以使用：

```text
http://127.0.0.1:8000
```

真机调试时需要改成 Mac 的局域网 IP，例如：

```text
http://192.168.1.23:8000
```

## 3. 注意事项

- 不要提交 `backend-node/.env`
- 不要提交 `backend-node/node_modules`
- 不要提交 Xcode 的 `xcuserdata`
- 可以提交 `backend-node/.env.example`，它只保存变量名，不保存真实密钥

## 4. RAG 知识库

知识库文档放在：

```text
backend-node/knowledge/
```

当前第一版 RAG 使用 Markdown 文档 + 关键词匹配：

```text
用户提问
  -> 后端搜索 backend-node/knowledge/*.md
  -> 找到相关资料
  -> 把资料和问题一起发给 AI
  -> AI 按结构化 JSON 返回
```

新增知识时，可以继续往 `backend-node/knowledge/` 里添加 `.md` 文件。

## 5. 多轮上下文

iOS 每次发送消息时，会把最近 6 条历史消息一起发送给后端：

```text
当前问题
  + 最近几条 user / assistant 历史
  -> Node.js
  -> AI API
```

这样用户继续追问：

```text
请更详细回答
继续
举个例子
```

AI 就能知道这些话是在接着上一轮问题说。

为了避免请求内容无限增长，当前只保留最近 6 条历史消息。

## 6. 流式输出

当前 App 默认使用第一版流式输出接口：

```text
POST /api/chat/stream
```

它的目标是让用户不用等完整回答结束，而是可以看到 AI 一边生成、一边显示：

```text
iOS 发送 message + history
  -> Node.js 做 RAG 检索
  -> Node.js 请求 DeepSeek stream: true
  -> DeepSeek 返回一小段文本
  -> Node.js 通过 SSE 转发给 iOS
  -> iOS 追加到同一条 AI 气泡
```

### 为什么保留 /api/chat

项目里仍然保留原来的结构化接口：

```text
POST /api/chat
```

两个接口的区别是：

```text
/api/chat
  -> 等 AI 完整返回
  -> 后端解析结构化 JSON
  -> iOS 展示 title / summary / points / next_question 卡片

/api/chat/stream
  -> AI 边生成边返回
  -> 后端通过 SSE 推送 delta
  -> iOS 实时更新普通文本气泡
```

第一版流式输出先返回普通文本，不强制 JSON。

原因是结构化 JSON 不适合直接流式展示。否则用户会先看到类似下面的半截内容：

```text
{"title":"SwiftUI @State","summary":"...
```

这不是自然的聊天体验。

后续可以升级成：

```text
流式阶段：显示普通文本
结束阶段：再返回最终 structured answer
iOS：把普通文本气泡替换成结构化卡片
```

### SSE 返回格式

后端使用 Server-Sent Events，也就是：

```text
Content-Type: text/event-stream
```

每个事件都是一行 `data:`，后面跟 JSON：

```text
data: {"type":"delta","delta":"SwiftUI "}

data: {"type":"delta","delta":"里的 @State "}

data: {"type":"delta","delta":"用于保存当前 View 的状态。"}

data: {"type":"done"}
```

如果流式过程中出错，后端会发送：

```text
data: {"type":"error","error":"Failed to stream AI response."}
```

iOS 只需要解析三种事件：

```text
delta：追加文本
done：结束本次回答
error：显示错误提示
```

### iOS 更新方式

流式输出时，iOS 不会等完整答案回来再追加 AI 消息。

它会先创建一条空的 assistant 消息：

```text
用户消息
AI 空消息
```

然后每收到一个 `delta`，就更新同一条 AI 消息的 `content`：

```text
AI 空消息
AI: SwiftUI
AI: SwiftUI 里的 @State
AI: SwiftUI 里的 @State 用于保存当前 View 的状态。
```

关键点是：这条 AI 消息的 `id` 必须保持不变。

如果每个 delta 都创建一个新 id，SwiftUI 会认为它们是很多条不同消息，列表滚动和动画都会不稳定。

### 和上下文记忆的关系

流式输出后，AI 回复是普通文本，不一定有 `structuredAnswer`。

所以整理 history 时不能只保存结构化回答，也要保存普通 assistant 文本。

当前逻辑会：

```text
排除第一条欢迎语
保留后续真实 user / assistant 消息
只取最近 6 条
发送给后端
```

这样用户继续追问：

```text
继续
举个例子
好，讲这个
```

AI 仍然能看到上一轮流式生成的回答内容。

### 手动测试流式接口

启动后端后，可以用 curl 测试：

```bash
curl -N \
  -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{
    "message": "SwiftUI 的 @State 是什么？",
    "system_prompt": "You are a friendly iOS tutor.",
    "history": []
  }'
```

`-N` 的作用是关闭 curl 的输出缓冲。

如果不加 `-N`，curl 可能会等攒够一批内容后再显示，看起来就不像实时流式输出。
