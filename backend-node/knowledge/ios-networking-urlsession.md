# iOS 使用 URLSession 请求后端

Keywords: iOS, Swift, URLSession, HTTP, POST, JSON, Codable, async await, backend

`URLSession` 是 iOS 原生的网络请求工具。

在这个项目里，iOS 使用 `URLSession` 向 Node.js 后端发送聊天请求。

## 请求流程

```text
创建 URL
  -> 创建 URLRequest
  -> 设置 HTTP Method 为 POST
  -> 设置 Content-Type 为 application/json
  -> 使用 JSONEncoder 编码请求体
  -> 使用 URLSession 发送请求
  -> 使用 JSONDecoder 解码响应体
```

## 请求体

iOS 发送给后端的数据类似：

```json
{
  "message": "SwiftUI 的 @State 是什么？",
  "system_prompt": "You are a friendly AI assistant..."
}
```

其中：

- `message` 是用户输入的问题
- `system_prompt` 是给 AI 的角色设定

## 响应体

当前后端返回结构化 JSON：

```json
{
  "title": "@State 是什么？",
  "summary": "@State 是 SwiftUI 中用于管理 View 内部状态的属性包装器。",
  "points": [
    "适合管理简单状态",
    "状态改变后 View 会自动刷新",
    "常用于输入框、开关、计数器"
  ],
  "next_question": "@State 和 @Binding 有什么区别？"
}
```

iOS 使用 `StructuredAnswer` 解码这份响应。

## 为什么使用 Codable

`Codable` 可以让 Swift 结构体和 JSON 自动转换。

例如：

```swift
struct StructuredAnswer: Decodable {
    let title: String
    let summary: String
    let points: [String]
    let nextQuestion: String
}
```

后端返回 `next_question`，Swift 里使用 `nextQuestion`。
可以通过 `decoder.keyDecodingStrategy = .convertFromSnakeCase` 自动转换。

