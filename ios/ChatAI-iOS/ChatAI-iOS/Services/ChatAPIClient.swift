//
//  ChatAPIClient.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import Foundation

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
