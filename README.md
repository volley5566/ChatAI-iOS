# AI iOS Chat Demo
<img width="1206" height="2622" alt="Simulator Screenshot - iPhone 17 Pro - 2026-05-13 at 19 03 58" src="https://github.com/user-attachments/assets/fb134342-727b-42dc-aaa7-428864719177" />
<img width="1206" height="2622" alt="Simulator Screenshot - iPhone 17 Pro - 2026-05-13 at 19 03 52" src="https://github.com/user-attachments/assets/095d8ead-6e9e-4186-ae92-8bc76dcc5e51" />



一个用于学习的 AI 聊天 Demo，包含：

- `ios/ChatAI-iOS`：SwiftUI iOS App
- `backend-node`：Node.js + Express 后端

调用流程：

```text
iOS SwiftUI
  -> Node.js /api/agent/stream
  -> Tool Calling / Agent Runner
  -> DeepSeek OpenAI-compatible API
  -> Node.js 通过 SSE 返回最终文本片段
  -> iOS 实时更新同一条 AI 消息气泡
```

项目里也保留了普通流式接口 `/api/chat/stream`
和非流式结构化接口 `/api/chat`，
方便后续继续做接口对比测试或“最终结构化卡片”升级。

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

## 5. 后端代码结构

后端已经按职责拆成多个模块，`server.ts` 只保留 Express 路由和 HTTP/SSE 生命周期。

```text
backend-node/src/server.ts
  Express 路由、SSE 连接、服务启动

backend-node/src/config.ts
  读取和校验 .env 配置

backend-node/src/deepseekClient.ts
  创建 DeepSeek/OpenAI-compatible SDK 客户端

backend-node/src/chatCompletion.ts
  普通聊天接口的 RAG 上下文和 messages 组装

backend-node/src/chatHistory.ts
  清洗 history，限制历史长度，组装检索 query

backend-node/src/knowledge.ts
  读取 backend-node/knowledge/*.md，并做轻量关键词检索

backend-node/src/prompts.ts
  结构化输出、普通流式输出、Agent 的 prompt 规则

backend-node/src/structuredAnswer.ts
  解析 /api/chat 的结构化 JSON 回答，并提供兜底解析

backend-node/src/agentTools.ts
  Tool Calling 工具定义、参数校验、工具执行、工具状态事件

backend-node/src/agentRunner.ts
  Agent Runner，负责 tool_call 循环和 DeepSeek reasoning_content 回传

backend-node/src/sse.ts
  统一写 SSE event

backend-node/src/types.ts
  后端共享类型
```

拆分后的职责关系：

```text
server.ts
  -> 普通聊天：chatCompletion + structuredAnswer + sse
  -> Agent 聊天：agentRunner -> agentTools -> knowledge
  -> 共用：config + deepseekClient + chatHistory + types
```

这样后续新增工具时，主要改 `agentTools.ts`；
调整 Agent 循环时，主要改 `agentRunner.ts`；
调整知识库检索时，主要改 `knowledge.ts`。

## 6. 多轮上下文

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

## 7. 流式输出

项目保留了普通流式输出接口：

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
data: {"type":"tool_start","tool_call_id":"call_xxx","tool_name":"searchKnowledge","display_name":"查询知识库","message":"正在查询知识库"}

data: {"type":"tool_done","tool_call_id":"call_xxx","tool_name":"searchKnowledge","display_name":"查询知识库","ok":true,"message":"已查询知识库，找到 2 条相关资料"}

data: {"type":"delta","delta":"SwiftUI "}

data: {"type":"delta","delta":"里的 @State "}

data: {"type":"delta","delta":"用于保存当前 View 的状态。"}

data: {"type":"done"}
```

如果流式过程中出错，后端会发送：

```text
data: {"type":"error","error":"Failed to stream AI response."}
```

iOS 只需要解析这几种事件：

```text
tool_start：显示 Agent 正在调用哪个工具
tool_done：显示工具执行结果摘要
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

## 8. Tool Calling / Agent

当前 App 默认使用第一版 Agent 流式接口：

```text
POST /api/agent/stream
```

它在普通流式输出前，增加了一个 Tool Calling 阶段：

```text
iOS 发送 message + history
  -> Node.js 把可用工具列表交给模型
  -> 模型判断是否需要调用工具
  -> Node.js 通过 SSE 发送 tool_start
  -> Node.js 校验工具名和参数
  -> Node.js 执行真正的后端工具
  -> Node.js 通过 SSE 发送 tool_done
  -> Node.js 把工具结果交回模型
  -> 模型生成最终回答
  -> Node.js 通过 SSE 流式返回给 iOS
```

### Tool Calling 是什么

Tool Calling 不是模型真的执行代码。

模型只会返回类似下面的结构化请求：

```json
{
  "name": "searchKnowledge",
  "arguments": {
    "query": "SwiftUI @State"
  }
}
```

真正执行工具的是 Node.js 后端。

这样做的好处是：

```text
模型负责理解用户意图、选择工具、组织回答
后端负责校验参数、执行工具、控制权限和安全边界
```

### 当前支持的工具

第一版 Agent 只开放两个低风险学习工具：

```text
searchKnowledge(query)
  搜索 backend-node/knowledge/ 里的 Markdown 知识库

generateQuiz(topic, count)
  根据学习主题生成 1 到 5 道练习题
```

这两个工具都不会修改数据，也不会调用外部业务系统，适合先把 Tool Calling 主流程跑通。

### Agent Runner 循环

后端里有一个简单 Agent Runner。

它的工作方式是：

```text
最多循环 4 轮

每一轮：
  调模型
  如果模型返回 tool_calls：
    后端执行工具
    把工具结果放回 messages
    继续下一轮

  如果模型没有返回 tool_calls：
    结束工具阶段
    进入最终回答阶段
```

为什么要限制最多 4 轮？

因为模型有可能反复调用工具。比如一直搜索知识库、一直换 query。
设置上限可以避免一次请求无限执行。

### 为什么最终回答仍然流式返回

Agent 的工具阶段是非流式的：

```text
模型决定工具
后端执行工具
模型看工具结果
```

工具阶段完成后，后端再开启 `stream: true`，把最终回答通过 SSE 返回给 iOS。

这样第一版实现更容易理解：

```text
工具调用阶段：稳定、易调试
最终回答阶段：用户体验仍然是流式
```

### iOS 如何展示 Agent 执行过程

Agent 接口会在工具开始和结束时发送额外 SSE 事件：

```text
tool_start
  -> iOS 在当前 AI 气泡里显示“正在查询知识库”

tool_done
  -> iOS 把同一步更新成“已查询知识库，找到 2 条相关资料”

delta
  -> iOS 继续把最终回答追加到同一条 AI 气泡
```

这样聊天列表仍然保持：

```text
用户一条消息
AI 一条消息
```

但 AI 消息内部能看到 Agent 调用了哪个工具。

后续如果要做更高级版本，可以继续升级成“流式 tool_call 参数拼接”，但第一版没必要一开始就做这么复杂。

### 手动测试 Agent 接口

启动后端后，可以测试知识库工具：

```bash
curl -N \
  -X POST http://127.0.0.1:8000/api/agent/stream \
  -H "Content-Type: application/json" \
  -d '{
    "message": "SwiftUI 的 @State 是什么？请先查知识库再回答。",
    "system_prompt": "You are a friendly iOS tutor.",
    "history": []
  }'
```

也可以测试练习题工具：

```bash
curl -N \
  -X POST http://127.0.0.1:8000/api/agent/stream \
  -H "Content-Type: application/json" \
  -d '{
    "message": "基于 SwiftUI @Binding 给我出 3 道练习题。",
    "system_prompt": "You are a friendly iOS tutor.",
    "history": []
  }'
```

如果后端日志里看到类似：

```text
[Agent] tool call: searchKnowledge, ok: true
[Agent] tool calls executed: 1
```

说明模型已经触发 Tool Calling，后端也执行了对应工具。
