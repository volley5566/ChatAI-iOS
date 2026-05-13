# AI iOS Chat Demo

一个用于学习的 AI 聊天 Demo，包含：

- `ios/ChatAI-iOS`：SwiftUI iOS App
- `backend-node`：Node.js + Express 后端

调用流程：

```text
iOS SwiftUI
  -> Node.js /api/chat
  -> DeepSeek OpenAI-compatible API
  -> Node.js 返回结构化 JSON
  -> iOS 按标题、摘要、重点列表展示 AI 回答
```

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
