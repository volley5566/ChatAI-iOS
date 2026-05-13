//
//  ChatAPIClient.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import Foundation

/// 网络层向 ViewModel 暴露的流式更新。
///
/// 后端 SSE 里现在不只有文本：
/// - delta：最终回答的一小段文本
/// - tool_start：Agent 开始执行工具
/// - tool_done：Agent 工具执行结束
///
/// 把它们整理成 enum 后，ViewModel 可以用 switch 明确处理每种事件。
enum ChatStreamUpdate: Equatable {
    case delta(String)
    case toolStart(AgentToolUpdate)
    case toolDone(AgentToolUpdate)
}

/// 一次 Agent 工具状态更新。
///
/// toolCallID 用来对应后端的 tool_call_id。
/// 同一个工具可能被调用多次，所以不能只靠 toolName 更新 UI。
struct AgentToolUpdate: Equatable {
    let toolCallID: String
    let toolName: String
    let displayName: String
    let message: String
    let ok: Bool?
}

/// 把“聊天接口”抽象成一个协议。
///
/// 现在项目很小，直接写 class 也可以。
/// 但用协议有一个好处：以后写单元测试或预览时，
/// 可以做一个假的 ChatAPI，避免每次都真的请求后端。
protocol ChatAPI {
    /// 给后端发送用户问题，返回 AI 的结构化回答。
    func sendMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) async throws -> StructuredAnswer

    /// 给后端发送用户问题，返回 AI 的流式文本片段。
    ///
    /// 第一版流式输出不返回 StructuredAnswer，
    /// 而是返回一段一段普通文本。
    ///
    /// ViewModel 会用 for try await 消费这个 stream：
    /// 每收到一个 delta，就把它追加到同一条 AI 消息气泡里。
    func sendStreamingMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) throws -> AsyncThrowingStream<String, Error>

    /// 给 Agent 后端发送用户问题，返回最终回答的流式文本片段。
    ///
    /// 和 sendStreamingMessage 的区别：
    /// - sendStreamingMessage 调普通流式聊天接口 /api/chat/stream
    /// - sendAgentStreamingMessage 调 Agent 接口 /api/agent/stream
    ///
    /// Agent 接口会先在后端执行 Tool Calling，
    /// 然后再把最终回答一段段推给 iOS。
    func sendAgentStreamingMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) throws -> AsyncThrowingStream<ChatStreamUpdate, Error>
}

/// iOS 调用 Node.js 后端时可能遇到的错误。
///
/// 遵守 LocalizedError 后，可以通过 error.localizedDescription
/// 拿到适合显示给用户看的错误文案。
enum ChatAPIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case serverMessage(String)
    case emptyAnswer

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "后端地址不正确，请检查 AppConfig.backendBaseURL。"
        case .invalidResponse:
            return "后端返回格式不正确，请确认 Node.js 服务是否正常。"
        case .serverMessage(let message):
            return message
        case .emptyAnswer:
            return "AI 返回了空内容，请稍后再试。"
        }
    }
}

/// 真正负责发 HTTP 请求的类。
///
/// 这个类只关心一件事：
/// 把 Swift 数据编码成 JSON -> 发给后端 -> 把后端 JSON 解码成 Swift 数据。
final class ChatAPIClient: ChatAPI {
    private let baseURL: URL
    private let urlSession: URLSession

    /// 依赖通过 init 传进来，代码会更容易测试。
    /// 正常运行时使用默认值即可。
    init(
        baseURL: URL = AppConfig.backendBaseURL,
        urlSession: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.urlSession = urlSession
    }

    func sendMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) async throws -> StructuredAnswer {
        /// 1. 拼出完整接口地址：
        /// baseURL = http://127.0.0.1:8000
        /// path    = /api/chat
        /// final   = http://127.0.0.1:8000/api/chat
        let url = baseURL.appending(path: "api/chat")

        /// 2. 创建 URLRequest。
        /// URLRequest 可以理解为“一次 HTTP 请求的说明书”：
        /// 请求哪个地址、用 GET 还是 POST、请求头是什么、请求体是什么。
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        /// 3. 把 Swift 结构体编码成 JSON 数据。
        /// 后端 server.ts 期望收到：
        /// {
        ///   "message": "...",
        ///   "system_prompt": "...",
        ///   "history": [
        ///     { "role": "user", "content": "上一轮用户问题" },
        ///     { "role": "assistant", "content": "上一轮 AI 回答" }
        ///   ]
        /// }
        let requestBody = ChatRequestBody(
            message: message,
            systemPrompt: systemPrompt,
            history: history
        )
        request.httpBody = try JSONEncoder().encode(requestBody)

        /// 4. 发起网络请求。
        /// await 表示这里会等待网络结果，但不会卡住 UI 主线程。
        let (data, response) = try await urlSession.data(for: request)

        /// 5. 确认后端返回的是 HTTP 响应。
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ChatAPIError.invalidResponse
        }

        /// 6. 只把 200...299 当成成功。
        /// 如果后端返回 400 / 500，就尝试读取后端的 error 字段。
        guard (200...299).contains(httpResponse.statusCode) else {
            if let errorBody = try? JSONDecoder().decode(ChatErrorResponseBody.self, from: data) {
                throw ChatAPIError.serverMessage(errorBody.error)
            }

            throw ChatAPIError.serverMessage("请求失败，HTTP 状态码：\(httpResponse.statusCode)")
        }

        /// 7. 把后端 JSON 解码成 Swift 结构体。
        /// 后端成功时返回：
        /// {
        ///   "title": "标题",
        ///   "summary": "摘要",
        ///   "points": ["重点 1", "重点 2"],
        ///   "next_question": "下一步问题"
        /// }
        let decoder = JSONDecoder()

        /// Node.js 返回的是 next_question，
        /// Swift 里更习惯写成 nextQuestion。
        /// convertFromSnakeCase 会自动完成这种转换。
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let structuredAnswer = try decoder.decode(StructuredAnswer.self, from: data)

        guard !structuredAnswer.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !structuredAnswer.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ChatAPIError.emptyAnswer
        }

        return structuredAnswer
    }

    func sendStreamingMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) throws -> AsyncThrowingStream<String, Error> {
        /// 普通流式聊天仍然保留给对比测试。
        ///
        /// 这个接口的特点是：
        /// - 后端会先做固定 RAG 检索
        /// - 模型不会自主选择工具
        /// - DeepSeek / OpenAI-compatible API 直接 stream: true 返回文本
        let updateStream = try sendStreamingRequest(
            path: "api/chat/stream",
            message: message,
            systemPrompt: systemPrompt,
            history: history
        )

        /**
         普通流式接口只需要文本 delta。

         这里把更通用的 ChatStreamUpdate 转回 String，
         保持 sendStreamingMessage 的老接口不变。
         如果后端未来给普通流式接口也发工具事件，旧调用方会自动忽略。
         */
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await update in updateStream {
                        if case .delta(let delta) = update {
                            continuation.yield(delta)
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    func sendAgentStreamingMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) throws -> AsyncThrowingStream<ChatStreamUpdate, Error> {
        /// Agent 流式聊天是当前 App 默认入口。
        ///
        /// 这个接口的特点是：
        /// - 后端先把工具列表交给模型
        /// - 模型可以返回 tool_call
        /// - 后端执行工具并把结果交回模型
        /// - 最终回答仍然通过同一套 SSE 解析逻辑返回给 iOS
        try sendStreamingRequest(
            path: "api/agent/stream",
            message: message,
            systemPrompt: systemPrompt,
            history: history
        )
    }

    private func sendStreamingRequest(
        path: String,
        message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) throws -> AsyncThrowingStream<ChatStreamUpdate, Error> {
        /// path 由上层入口传入。
        ///
        /// 这样普通流式聊天和 Agent 流式聊天可以共用：
        /// - JSON 请求体编码
        /// - HTTP 状态码处理
        /// - SSE data 行解析
        /// - AsyncThrowingStream 取消逻辑
        ///
        /// 差异只保留在后端 URL 上，避免两套几乎一样的网络代码。

        /// 1. 拼出流式接口地址。
        ///
        /// 现在有两个流式接口：
        /// - /api/chat/stream：普通流式聊天
        /// - /api/agent/stream：Tool Calling Agent，后端会先执行工具，再流式返回最终回答
        let url = baseURL.appending(path: path)

        /// 2. 创建 URLRequest。
        ///
        /// 流式接口虽然返回的是 text/event-stream，
        /// 但请求体仍然是 JSON：
        /// {
        ///   "message": "...",
        ///   "system_prompt": "...",
        ///   "history": [...]
        /// }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let requestBody = ChatRequestBody(
            message: message,
            systemPrompt: systemPrompt,
            history: history
        )
        request.httpBody = try JSONEncoder().encode(requestBody)

        /**
         AsyncThrowingStream 的作用：

         - 后端每推送一个 SSE 事件，网络层就 yield 一个 ChatStreamUpdate。
         - ViewModel 可以用 for try await 像读数组一样读取这些更新。
         - 如果网络失败、后端返回 error 事件，stream 会 finish(throwing:)。

         这样 UI 层不用理解 SSE 协议，只关心“文本片段或工具状态”。
         */
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    /**
                     URLSession.bytes(for:) 会在收到响应头后就返回，
                     后续 body 可以通过 bytes.lines 一行一行读取。

                     这正好适合 SSE：
                     后端会持续写入：
                     data: {"type":"delta","delta":"..."}
                     空行
                     data: {"type":"done"}
                     空行
                     */
                    let (bytes, response) = try await urlSession.bytes(for: request)

                    guard let httpResponse = response as? HTTPURLResponse else {
                        continuation.finish(throwing: ChatAPIError.invalidResponse)
                        return
                    }

                    /**
                     如果后端在建立 SSE 之前就返回 400 / 500，
                     响应体仍然是普通 JSON error。

                     这里把剩余 body 读成文本，再尝试解析 error 字段，
                     这样用户看到的错误会和非流式接口保持一致。
                     */
                    guard (200...299).contains(httpResponse.statusCode) else {
                        var errorText = ""

                        for try await line in bytes.lines {
                            errorText += line
                        }

                        if let errorData = errorText.data(using: .utf8),
                           let errorBody = try? JSONDecoder().decode(ChatErrorResponseBody.self, from: errorData) {
                            continuation.finish(throwing: ChatAPIError.serverMessage(errorBody.error))
                            return
                        }

                        continuation.finish(
                            throwing: ChatAPIError.serverMessage("请求失败，HTTP 状态码：\(httpResponse.statusCode)")
                        )
                        return
                    }

                    let decoder = JSONDecoder()
                    let dataPrefix = "data:"

                    /**
                     SSE 是按“行”传输的。
                     当前后端每个事件只写一行 data：
                     data: {"type":"delta","delta":"文本片段"}

                     空行表示一个事件结束。
                     因为后端已经把每个事件压成一行 JSON，
                     iOS 这里只需要处理 data: 开头的行即可。
                     */
                    for try await line in bytes.lines {
                        guard line.hasPrefix(dataPrefix) else {
                            continue
                        }

                        let jsonText = String(line.dropFirst(dataPrefix.count))
                            .trimmingCharacters(in: .whitespacesAndNewlines)

                        guard let eventData = jsonText.data(using: .utf8) else {
                            continue
                        }

                        let event = try decoder.decode(ChatStreamEvent.self, from: eventData)

                        switch event.type {
                        case "delta":
                            /**
                             delta 是模型新生成的一小段文本。
                             它可能是一个字、一个词，也可能是一小句话。
                             UI 层只需要把它追加到当前 AI 消息后面。
                             */
                            if let delta = event.delta, !delta.isEmpty {
                                continuation.yield(.delta(delta))
                            }

                        case "tool_start":
                            /**
                             tool_start 表示 Agent 已经决定调用某个工具。
                             这时最终答案还没开始生成，但 UI 可以先显示：
                             “正在查询知识库”“正在生成练习题”。
                             */
                            if let toolUpdate = event.agentToolUpdate {
                                continuation.yield(.toolStart(toolUpdate))
                            }

                        case "tool_done":
                            /**
                             tool_done 表示后端工具已经执行完。
                             它只携带适合 UI 展示的摘要，不携带完整工具结果。
                             完整工具结果仍然只交给模型整理最终回答。
                             */
                            if let toolUpdate = event.agentToolUpdate {
                                continuation.yield(.toolDone(toolUpdate))
                            }

                        case "done":
                            /// done 表示后端已经读完模型流，本次回答结束。
                            continuation.finish()
                            return

                        case "error":
                            /// error 表示 SSE 连接建立后，后端或模型流中途失败。
                            let message = event.error ?? "流式响应失败，请稍后再试。"
                            continuation.finish(throwing: ChatAPIError.serverMessage(message))
                            return

                        default:
                            /**
                             为了兼容未来扩展，未知事件先忽略。
                             例如以后可能增加 source / metadata / structured_done。
                             老版本 iOS 不认识这些事件，也不应该因此中断聊天。
                             */
                            continue
                        }
                    }

                    /**
                     理论上后端会明确发送 done。
                     如果连接自然结束但没收到 done，这里也正常 finish，
                     避免 UI 永远卡在发送状态。
                     */
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            /**
             如果用户取消任务、页面销毁，AsyncThrowingStream 会终止。
             这里同步取消底层网络 Task，避免请求继续在后台跑。
             */
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}

/// 请求体：iOS -> Node.js。
///
/// Codable / Encodable 的作用：
/// 让 Swift 结构体可以自动变成 JSON。
private struct ChatRequestBody: Encodable {
    let message: String
    let systemPrompt: String
    let history: [ChatHistoryItem]

    /// Swift 通常用驼峰命名 systemPrompt；
    /// 后端现在用下划线命名 system_prompt。
    /// CodingKeys 用来告诉 JSONEncoder：
    /// Swift 的 systemPrompt 要编码成 JSON 里的 system_prompt。
    enum CodingKeys: String, CodingKey {
        case message
        case systemPrompt = "system_prompt"
        case history
    }
}

/// 失败响应体：Node.js -> iOS。
private struct ChatErrorResponseBody: Decodable {
    let error: String
}

/// 后端流式接口通过 SSE 推给 iOS 的事件。
///
/// 对应后端格式：
/// data: {"type":"delta","delta":"..."}
/// data: {"type":"tool_start","tool_call_id":"...","tool_name":"searchKnowledge",...}
/// data: {"type":"tool_done","tool_call_id":"...","tool_name":"searchKnowledge",...}
/// data: {"type":"done"}
/// data: {"type":"error","error":"..."}
private struct ChatStreamEvent: Decodable {
    let type: String
    let delta: String?
    let error: String?
    let toolCallID: String?
    let toolName: String?
    let displayName: String?
    let message: String?
    let ok: Bool?

    enum CodingKeys: String, CodingKey {
        case type
        case delta
        case error
        case toolCallID = "tool_call_id"
        case toolName = "tool_name"
        case displayName = "display_name"
        case message
        case ok
    }

    /// 把 SSE 原始字段整理成 ViewModel 更好消费的工具状态。
    var agentToolUpdate: AgentToolUpdate? {
        guard let toolCallID,
              let toolName,
              let displayName,
              let message else {
            return nil
        }

        return AgentToolUpdate(
            toolCallID: toolCallID,
            toolName: toolName,
            displayName: displayName,
            message: message,
            ok: ok
        )
    }
}
