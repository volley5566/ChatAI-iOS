//
//  ChatAPIClient.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import Foundation

/// 整体架构：
///
/// ChatViewModel
///     ↓ 调用协议
/// ChatAPI
///     ↓ 真实实现
/// ChatAPIClient
///     ↓
/// URLSession
///     ↓
/// Node.js 后端
///     ↓
/// AI / Agent / Tool Calling

/// 网络层向 ViewModel 暴露的流式更新。
/// 给 ViewModel 用的流式事件。
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
    /// Phase 9 #3 — HITL: 后端把一个 LLM-as-tool 调用挂起,等用户审批。
    ///
    /// 后端发 `tool_pending` SSE 事件后,流会很快结束(图挂起在 toolNode),
    /// VM 收到这个 update 应该:
    ///   1. 把 pending 存到 @Published pendingApproval(让 UI 弹卡片)
    ///   2. 不再追加 streamedAnswer(模型还没生成最终回答)
    ///   3. 用户在卡片上点完按钮后,调 resumeThread() 续跑
    case toolPending(PendingApproval)
    /// Phase 10.1 #4 — 后端 SSE done 事件,带回 LangSmith 根 run id。
    ///
    /// 故意做成"流的最后一个事件",而不是把 run_id 挂在某个回调外参数上——
    /// VM 处理它的方式和处理 delta / toolStart 一样,统一在 `for try await ... in stream` 循环里 switch,
    /// 不引入"流外的副渠道"。
    ///
    /// runID 可选:LANGSMITH_TRACING 关掉时后端不会带这个字段(或带 null),
    /// VM 拿到 nil 时就跳过"把 runId 写到消息上"那一步——结果是 MessageBubbleView
    /// 自然不显示反馈按钮(它的判定就是 runId != nil)。
    ///
    /// Phase 9 #3 — done 事件可能携带 pending(图挂起时的最后通知)。
    /// 这是"双保险":即使 tool_pending SSE 事件因为网络丢失/解析失败没收到,
    /// done.pending 也能让 VM 知道当前在审批态。
    case done(runID: String?, pending: PendingApproval?)
}

/// 一次 Agent 工具状态更新。
///
/// toolCallID 用来对应后端的 tool_call_id。
/// 同一个工具可能被调用多次，所以不能只靠 toolName 更新 UI。
///
/// 它表示后端告诉 iOS：
/// - 某个工具开始了
/// - 某个工具完成了
/// - 某个工具失败了
struct AgentToolUpdate: Equatable {
    let toolCallID: String
    let toolName: String
    let displayName: String
    let message: String
    let ok: Bool?
}

/// ChatAPI 协议：网络层抽象，聊天网络接口应该具备哪些能力。
/// 把“聊天接口”抽象成一个协议。
///
/// 现在项目很小，直接写 class 也可以。
/// 但用协议有一个好处：以后写单元测试或预览时，
/// 可以做一个假的 ChatAPI，避免每次都真的请求后端。
///
/// 重要：
/// 因为 ViewModel 依赖的是：private let chatAPI: ChatAPI
/// 而不是直接依赖：private let chatAPI = ChatAPIClient()
protocol ChatAPI {
    /// 给后端发送用户问题，返回 AI 的结构化回答。
    /// 普通非流式结构化回答。
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
    /// 普通流式文本回答。
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
    /// Agent 流式回答，包含工具状态和文本片段。
    ///
    /// Phase 5.5 新增 threadID 参数:
    /// - 传入有效 id → 后端启用 LangGraph checkpointer,自动加载历史 + 写回新 state
    /// - 传 nil → 走旧路径(无持久化,靠 history 数组带历史),兼容老 ViewModel
    func sendAgentStreamingMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem],
        threadID: String?
    ) throws -> AsyncThrowingStream<ChatStreamUpdate, Error>

    // ─────────────────────────────────────────────────────────────────────
    // Phase 5.5.4 — 对话管理 API
    //
    // 这 4 个接口和聊天接口的本质区别:
    //   - 聊天接口走 SSE 流式 → AsyncThrowingStream
    //   - 对话管理是离散的 CRUD 操作 → 普通 async/await
    //
    // 都不会失败重试——5.5 阶段只做最简单的"调一次,成功就用,失败就提示用户"。
    // 后续如果加"网络抖动自动重试"那是 Service 层 wrapper 的事,不污染 API 协议。
    // ─────────────────────────────────────────────────────────────────────

    /// 新建一个对话。
    ///
    /// 对应后端 POST /api/threads。
    /// title 可选——传 nil 时后端存 null,以后可由模型根据首条消息生成标题。
    ///
    /// 返回新建对话的元信息(含 id),iOS 端拿到 id 后,
    /// 后续 sendAgentStreamingMessage(..., threadID: ...) 就能持久化。
    func createThread(title: String?) async throws -> ThreadSummary

    /// 列出所有对话,按最近活跃倒序。
    ///
    /// 对应后端 GET /api/threads。
    /// 给"对话列表页"(5.6 才会做的 UI)使用。
    func listThreads() async throws -> [ThreadSummary]

    /// 拉某个对话的全部可展示消息。
    ///
    /// 对应后端 GET /api/threads/:id/messages。
    /// 切换到历史对话时调一次,把消息填回聊天界面。
    ///
    /// 返回的是 ThreadMessage(role + content),
    /// 不是 ChatMessage——ViewModel 自己负责转换。
    func getThreadMessages(threadID: String) async throws -> [ThreadMessage]

    /// 删除一个对话(同时清掉后端 checkpointer 里的 state 快照)。
    ///
    /// 对应后端 DELETE /api/threads/:id。
    /// 幂等——id 不存在也返回成功(后端 204)。
    func deleteThread(threadID: String) async throws

    /// Phase 10.1 #4 — 用户对某条 AI 回答的反馈(👍 / 👎)。
    ///
    /// 对应后端 POST /api/feedback —— 后端会把分数写到 LangSmith
    /// 对应那条 trace 的 Feedback 区。
    ///
    /// 参数:
    ///   - runID:那条 AI 回答的根 run id(从 SSE done 事件存下来,Message.runId)
    ///   - score:0..1 浮点;UI 当前只发 1(👍)或 0(👎),留浮点给未来星级扩展
    ///
    /// 失败会抛 ChatAPIError——ViewModel 应该把已乐观写入的 feedbackScore 还原回 nil,
    /// 并显示 errorMessage 提示用户重试。
    func submitFeedback(runID: String, score: Double) async throws

    /// Phase 9 #3 — HITL 续跑挂起的 Agent。
    ///
    /// 对应后端 POST /api/threads/:id/resume。
    /// 行为和 sendAgentStreamingMessage 一致(SSE 流式),只是入参不同:
    ///   - approved=true,editedArgs=nil    → 用原参数执行工具
    ///   - approved=true,editedArgs=[...]   → 用编辑过的参数执行工具
    ///   - approved=false                   → 跳过工具,模型基于 "user denied" 改口
    ///
    /// 返回的流可能再次出现 tool_pending(模型批准后又想调另一个 LLM-as-tool)。
    func resumeThread(
        threadID: String,
        approved: Bool,
        editedArgs: [String: JSONValue]?
    ) throws -> AsyncThrowingStream<ChatStreamUpdate, Error>

    // ─────────────────────────────────────────────────────────────────────
    // Phase 9 #7-#8 — Time-travel(时光机)
    // ─────────────────────────────────────────────────────────────────────

    /// 列出某个 thread 的所有"用户可分叉时刻"。
    ///
    /// 对应后端 GET /api/threads/:id/checkpoints。
    /// 返回的 checkpoints 按时间正序(最早的在前面),长度等于 thread 中
    /// "AI 说完完整回答"的次数 —— 也就是 iOS 端可见 AI 消息的条数。
    ///
    /// 调用时机:ChatView 出现时 .task 里调一次,把结果缓存到 VM。
    /// 后续用户长按 AI 消息时,直接用"第 N 条 AI 消息" → 第 N 个 checkpoint。
    func listCheckpoints(threadID: String) async throws -> [Checkpoint]

    /// 从某个 checkpoint 分叉出一个新 thread。
    ///
    /// 对应后端 POST /api/threads/:id/fork。
    /// title 可选;不传后端会自动生成默认标题("分叉对话 · N 条消息")。
    ///
    /// 返回新建 thread 的 summary,iOS 拿到 id 后用户可以选择跳转过去。
    func forkThread(
        threadID: String,
        checkpointID: String,
        title: String?
    ) async throws -> ThreadSummary
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

/// ChatAPIClient：真正发请求的类。
/// 它实现了 ChatAPI 协议。
/// 真正负责发 HTTP 请求的类。
///
/// 这个类只关心一件事：
/// 把 Swift 数据编码成 JSON -> 发给后端 -> 把后端 JSON 解码成 Swift 数据。
final class ChatAPIClient: ChatAPI {
    // 里面有两个核心成员，这里通过 init 传入。

    /// 后端基础地址。
    private let baseURL: URL

    /// URLSession 是 iOS 原生网络请求工具。
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

    /// 给后端发送用户问题，等待后端一次性返回完整 StructuredAnswer。
    ///
    /// 1. 拼 URL
    /// 2. 创建 URLRequest
    /// 3. 设置 POST 和 Content-Type
    /// 4. 编码请求体 JSON
    /// 5. 用 URLSession 发请求
    /// 6. 检查 HTTP 响应
    /// 7. 检查状态码
    /// 8. 解码 StructuredAnswer
    /// 9. 检查是否为空
    /// 10. 返回结果
    func sendMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) async throws -> StructuredAnswer {
        // 1. 拼出完整接口地址：
        // baseURL = http://127.0.0.1:8000
        // path    = /api/chat
        // final   = http://127.0.0.1:8000/api/chat
        let url = baseURL.appending(path: "api/chat")

        // 2. 创建 URLRequest。
        // URLRequest 可以理解为“一次 HTTP 请求的说明书”：
        // 请求哪个地址、用 GET 还是 POST、请求头是什么、请求体是什么。
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // 3. 把 Swift 结构体编码成 JSON 数据。
        // 后端 server.ts 期望收到：
        // {
        //   "message": "...",
        //   "system_prompt": "...",
        //   "history": [
        //     { "role": "user", "content": "上一轮用户问题" },
        //     { "role": "assistant", "content": "上一轮 AI 回答" }
        //   ]
        // }
        let requestBody = ChatRequestBody(
            message: message,
            systemPrompt: systemPrompt,
            history: history,
            // 非流式结构化接口 /api/chat 后端不走 checkpointer,
            // thread_id 在这里没意义,固定 nil(JSON 里会被自动省略)。
            threadID: nil
        )
        request.httpBody = try JSONEncoder().encode(requestBody)

        // 4. 发起网络请求。
        // await 表示这里会等待网络结果，但不会卡住 UI 主线程。
        let (data, response) = try await urlSession.data(for: request)

        // 5. 确认后端返回的是 HTTP 响应。
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ChatAPIError.invalidResponse
        }

        // 6. 只把 200...299 当成成功。
        // 如果后端返回 400 / 500，就尝试读取后端的 error 字段。
        guard (200...299).contains(httpResponse.statusCode) else {
            if let errorBody = try? JSONDecoder().decode(ChatErrorResponseBody.self, from: data) {
                throw ChatAPIError.serverMessage(errorBody.error)
            }

            throw ChatAPIError.serverMessage("请求失败，HTTP 状态码：\(httpResponse.statusCode)")
        }

        // 7. 把后端 JSON 解码成 Swift 结构体。
        // 后端成功时返回：
        // {
        //   "title": "标题",
        //   "summary": "摘要",
        //   "points": ["重点 1", "重点 2"],
        //   "next_question": "下一步问题"
        // }
        let decoder = JSONDecoder()

        // Node.js 返回的是 next_question，
        // Swift 里更习惯写成 nextQuestion。
        // convertFromSnakeCase 会自动完成这种转换。
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let structuredAnswer = try decoder.decode(StructuredAnswer.self, from: data)

        guard !structuredAnswer.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !structuredAnswer.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ChatAPIError.emptyAnswer
        }

        return structuredAnswer
    }

    /// 普通流式请求。
    func sendStreamingMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem]
    ) throws -> AsyncThrowingStream<String, Error> {
        // 也就是说，它只返回文本片段。
        // 普通流式聊天仍然保留给对比测试。
        //
        // 这个接口的特点是：
        // - 后端会先做固定 RAG 检索
        // - 模型不会自主选择工具
        // - DeepSeek / OpenAI-compatible API 直接 stream: true 返回文本
        let updateStream = try sendStreamingRequest(
            path: "api/chat/stream",
            message: message,
            systemPrompt: systemPrompt,
            history: history,
            // 普通流式接口 /api/chat/stream 后端也不走 checkpointer,
            // 这里固定 nil——保持普通流式作为"对比测试用"的纯净老路径。
            threadID: nil
        )

        // 普通流式接口只需要文本 delta。
        //
        // 这里把更通用的 ChatStreamUpdate 转回 String，
        // 保持 sendStreamingMessage 的老接口不变。
        // 如果后端未来给普通流式接口也发工具事件，旧调用方会自动忽略。
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

    /// Agent 流式请求。
    ///
    /// 普通流式：
    ///     只返回 AI 文本片段
    ///
    /// Agent 流式：
    ///     可能先返回工具执行状态
    ///     再返回 AI 文本片段
    ///
    /// AsyncThrowingStream 可以异步不断吐数据的流，而且可能抛错误。
    /// 类比 Flow<ChatStreamUpdate>。
    ///
    /// 后端不是一次性返回完整答案，而是一段一段持续返回。
    ///
    /// AsyncThrowingStream 里面有一个 continuation：
    /// - continuation.yield(...) 给外部吐出一条数据
    /// - continuation.finish() 正常结束
    /// - continuation.finish(throwing: error) 以错误结束
    func sendAgentStreamingMessage(
        _ message: String,
        systemPrompt: String,
        history: [ChatHistoryItem],
        threadID: String?
    ) throws -> AsyncThrowingStream<ChatStreamUpdate, Error> {
        // Agent 流式聊天是当前 App 默认入口。
        //
        // 这个接口的特点是：
        // - 后端先把工具列表交给模型
        // - 模型可以返回 tool_call
        // - 后端执行工具并把结果交回模型
        // - 最终回答仍然通过同一套 SSE 解析逻辑返回给 iOS
        //
        // Phase 5.5:threadID 一路透传到 sendStreamingRequest → ChatRequestBody → JSON 的 thread_id 字段,
        // 后端收到非空 thread_id 时启用 checkpointer,实现跨请求的对话持久化。
        try sendStreamingRequest(
            path: "api/agent/stream",
            message: message,
            systemPrompt: systemPrompt,
            history: history,
            threadID: threadID
        )
    }

    /// 它是普通流式和 Agent 流式的公共底层实现。
    ///
    /// sendStreamingMessage
    ///     ↓
    /// sendStreamingRequest(path: "api/chat/stream")
    ///
    /// sendAgentStreamingMessage
    ///     ↓
    /// sendStreamingRequest(path: "api/agent/stream")
    private func sendStreamingRequest(
        path: String,
        message: String,
        systemPrompt: String,
        history: [ChatHistoryItem],
        threadID: String?
    ) throws -> AsyncThrowingStream<ChatStreamUpdate, Error> {
        // path 由上层入口传入。
        //
        // 这样普通流式聊天和 Agent 流式聊天可以共用：
        // - JSON 请求体编码
        // - HTTP 状态码处理
        // - SSE data 行解析
        // - AsyncThrowingStream 取消逻辑
        //
        // 差异只保留在后端 URL 上，避免两套几乎一样的网络代码。

        // 1. 拼出流式接口地址。
        //
        // 现在有两个流式接口：
        // - /api/chat/stream：普通流式聊天
        // - /api/agent/stream：Tool Calling Agent，后端会先执行工具，再流式返回最终回答
        let url = baseURL.appending(path: path)//拼 URL

        // 2. 创建 URLRequest。
        //
        // 流式接口虽然返回的是 text/event-stream，
        // 但请求体仍然是 JSON：
        // {
        //   "message": "...",
        //   "system_prompt": "...",
        //   "history": [...]
        // }
        // 响应体是 text/event-stream，也就是 SSE
        var request = URLRequest(url: url)//-URLRequest ≈ Retrofit 的 @POST + @Body,或 OkHttp 的 Request.Builder
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let requestBody = ChatRequestBody(
            message: message,
            systemPrompt: systemPrompt,
            history: history,
            threadID: threadID
        )
        request.httpBody = try JSONEncoder().encode(requestBody)

        // AsyncThrowingStream 的作用：
        //
        // - 后端每推送一个 SSE 事件，网络层就 yield 一个 ChatStreamUpdate。
        // - ViewModel 可以用 for try await 像读数组一样读取这些更新。
        // - 如果网络失败、后端返回 error 事件，stream 会 finish(throwing:)。
        //
        // 这样 UI 层不用理解 SSE 协议，只关心“文本片段或工具状态”。
        //
        //AsyncThrowingStream 是 Swift 的"我自己控制何时吐数据"的工具。
        //- continuation.yield(x) = 吐一个值给下游
        //- continuation.finish() = 流正常结束
        //- continuation.finish(throwing:) = 流抛异常结束
        //- onTermination = 下游不要了/出错了,清理这里(取消网络 task)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    // URLSession.bytes(for:) 会在收到响应头后就返回，
                    // 后续 body 可以通过 bytes.lines 一行一行读取。
                    //
                    // 这正好适合 SSE：
                    // 后端会持续写入：
                    // data: {"type":"delta","delta":"..."}
                    // 空行
                    // data: {"type":"done"}
                    // 空行
                    // 真正体现“这是 SSE 流式响应”的地方，是这里。
                    // SSE 全称是 Server-Sent Events：
                    // 后端和前端建立一个长连接，后端可以不断往前端推送消息。
                    // 适合流式接口：请求 -> 后端持续推送 -> iOS 一边收一边处理。
                    //
                    // bytes(for:) 收到响应头后就返回，
                    // 后续响应体可以一行一行读取。
                    let (bytes, response) = try await urlSession.bytes(for: request)//发起请求 + 拿到字节流 urlSession.bytes(for:) 和普通 data(for:) 的区别——bytes 在响应头一到就 return,后续 body 通过 bytes.lines 一行一行异步迭代,不用等整个响应结束。这正是流式接口需要的行为。

                    guard let httpResponse = response as? HTTPURLResponse else {
                        continuation.finish(throwing: ChatAPIError.invalidResponse)
                        return
                    }

                    // 如果后端在建立 SSE 之前就返回 400 / 500，
                    // 响应体仍然是普通 JSON error。
                    //
                    // 这里把剩余 body 读成文本，再尝试解析 error 字段，
                    // 这样用户看到的错误会和非流式接口保持一致。
                    // 检查流式接口 HTTP 状态码。
                    guard (200...299).contains(httpResponse.statusCode) else {
                        var errorText = ""

                        // 这说明你的 iOS 端不是等一个完整 JSON 返回，
                        // 而是在一行一行读取后端持续推送的数据。
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

                    // SSE 是按“行”传输的。
                    // 当前后端每个事件只写一行 data：
                    // data: {"type":"delta","delta":"文本片段"}
                    //
                    // 空行表示一个事件结束。
                    // 因为后端已经把每个事件压成一行 JSON，
                    // iOS 这里只需要处理 data: 开头的行即可。
                    // 逐行读取 SSE。
                    for try await line in bytes.lines {//所以 iOS 端读 bytes.lines 是天然适配 SSE 的
                        // 只处理 data: 开头的行。
                        guard line.hasPrefix(dataPrefix) else {
                            continue
                        }

                        // 去掉 data:
                        // data: {"type":"delta","delta":"SwiftUI"}
                        // {"type":"delta","delta":"SwiftUI"}
                        let jsonText = String(line.dropFirst(dataPrefix.count))
                            .trimmingCharacters(in: .whitespacesAndNewlines)

                        guard let eventData = jsonText.data(using: .utf8) else {
                            continue
                        }

                        // String 转 Data：
                        // 因为 JSONDecoder 解码需要的是 Data，不是 String，
                        // 所以要把 JSON 字符串转成 UTF-8 Data。
                        let event = try decoder.decode(ChatStreamEvent.self, from: eventData)//让 Swift struct 自动转 JSON

                        // 处理不同 SSE 事件。
                        switch event.type {
                        case "delta":
                            // delta 是模型新生成的一小段文本。
                            // 它可能是一个字、一个词，也可能是一小句话。
                            // UI 层只需要把它追加到当前 AI 消息后面。
                            if let delta = event.delta, !delta.isEmpty {
                                continuation.yield(.delta(delta))
                            }

                        case "tool_start":
                            // tool_start 表示 Agent 已经决定调用某个工具。
                            // 这时最终答案还没开始生成，但 UI 可以先显示：
                            // “正在查询知识库”“正在生成练习题”。
                            if let toolUpdate = event.agentToolUpdate {
                                continuation.yield(.toolStart(toolUpdate))
                            }

                        case "tool_done":
                            // tool_done 表示后端工具已经执行完。
                            // 它只携带适合 UI 展示的摘要，不携带完整工具结果。
                            // 完整工具结果仍然只交给模型整理最终回答。
                            if let toolUpdate = event.agentToolUpdate {
                                continuation.yield(.toolDone(toolUpdate))
                            }

                        case "tool_pending":
                            // Phase 9 #3 — HITL: 工具调用挂起,等用户审批。
                            // tool_pending 之后流会很快结束(done 事件随后到达),
                            // VM 会把 pendingApproval 存起来弹卡片。
                            if let pending = event.pendingApproval {
                                continuation.yield(.toolPending(pending))
                            }

                        case "done":
                            // done 表示后端已经读完模型流，本次回答结束。
                            //
                            // Phase 10.1 #4 — 在 finish() 之前先 yield 一条 .done(runID:)。
                            // 这样 VM 的 for-await 循环能在最后一轮拿到 run_id,
                            // 把它存到对应那条 assistant 消息上,反馈按钮才能渲染出来。
                            //
                            // event.runID 可能为 nil(后端没开 LangSmith 或拿不到根 run id),
                            // 那就传 nil,VM 会跳过赋值——MessageBubbleView 看到 runId == nil
                            // 就不显示反馈按钮,行为自然降级。
                            //
                            // Phase 9 #3 — done 也可能携带 pending(HITL 挂起态)。
                            // event.pending 是后端在图被挂起时塞进 done 的双保险。
                            continuation.yield(.done(
                                runID: event.runID,
                                pending: event.pending?.toPendingApproval()
                            ))
                            continuation.finish()
                            return

                        case "error":
                            // error 表示 SSE 连接建立后，后端或模型流中途失败。
                            let message = event.error ?? "流式响应失败，请稍后再试。"
                            continuation.finish(throwing: ChatAPIError.serverMessage(message))
                            return

                        default:
                            // 为了兼容未来扩展，未知事件先忽略。
                            // 例如以后可能增加 source / metadata / structured_done。
                            // 老版本 iOS 不认识这些事件，也不应该因此中断聊天。
                            continue
                        }
                    }

                    // 理论上后端会明确发送 done。
                    // 如果连接自然结束但没收到 done，这里也正常 finish，
                    // 避免 UI 永远卡在发送状态。
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            // 如果用户取消任务、页面销毁，AsyncThrowingStream 会终止。
            // 这里同步取消底层网络 Task，避免请求继续在后台跑。
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase 5.5.4 — 对话管理 API 实现
    // ─────────────────────────────────────────────────────────────────────

    /// 新建对话。POST /api/threads
    ///
    /// 流程:
    /// 1. (可选)把 title 包成请求体 JSON
    /// 2. 发 POST,后端建库后返回新 thread
    /// 3. 解码成 ThreadSummary 返回
    func createThread(title: String?) async throws -> ThreadSummary {
        /**
         * 构造请求体——只有 title 一个字段,而且可选。
         *
         * 这里没用上面的 ChatRequestBody(那个是聊天用),也没专门建一个 struct,
         * 直接用 [String: String] 字典编码 JSON。理由:字段只有一个、不会复用,
         * 多建一个 struct 反而代码噪音。
         *
         * 如果以后 title 之外还要传别的(比如 model preference / system prompt template),
         * 再升级成专用 struct 不迟。
         */
        var bodyDict: [String: String] = [:]
        if let title, !title.isEmpty {
            bodyDict["title"] = title
        }
        let bodyData = try JSONEncoder().encode(bodyDict)

        let data = try await performJSONRequest(method: "POST", path: "api/threads", body: bodyData)
        return try Self.makeThreadDecoder().decode(ThreadSummary.self, from: data)
    }

    /// 列出全部对话。GET /api/threads
    func listThreads() async throws -> [ThreadSummary] {
        let data = try await performJSONRequest(method: "GET", path: "api/threads", body: nil)
        /**
         * 后端返回的是 { "threads": [...] } 而不是裸数组——
         * 这是后端约定,留出未来加 total / next_cursor 这种分页字段的空间。
         * iOS 这边定义个本地 wrapper struct 接住,再返回数组,
         * 让外层 API 看起来更简洁。
         */
        let wrapper = try Self.makeThreadDecoder().decode(ThreadListResponseBody.self, from: data)
        return wrapper.threads
    }

    /// 拉某个对话的消息历史。GET /api/threads/:id/messages
    func getThreadMessages(threadID: String) async throws -> [ThreadMessage] {
        /**
         * URL 路径里的 :id 用 ID 替换,记得做 URL 安全转义——
         * 虽然后端用 uuid(只含 0-9a-f-),正常不会出问题,
         * 但万一以后 id 格式换了带特殊字符,addingPercentEncoding 能兜底。
         */
        let encodedID = threadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadID
        let data = try await performJSONRequest(method: "GET", path: "api/threads/\(encodedID)/messages", body: nil)

        /**
         * 同 listThreads,后端用 { "messages": [...] } 包了一层。
         * 这里也用 wrapper struct 接住。
         */
        let wrapper = try Self.makeThreadDecoder().decode(ThreadMessagesResponseBody.self, from: data)
        return wrapper.messages
    }

    /// 删除一个对话。DELETE /api/threads/:id
    func deleteThread(threadID: String) async throws {
        let encodedID = threadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadID
        /**
         * DELETE 成功后端返回 204 No Content(没有响应体)。
         * performJSONRequest 会拿到一个空 Data,这里直接丢掉就行。
         */
        _ = try await performJSONRequest(method: "DELETE", path: "api/threads/\(encodedID)", body: nil)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase 9 #7-#8 — Time-travel(时光机)
    // ─────────────────────────────────────────────────────────────────────

    /// 列 checkpoints。GET /api/threads/:id/checkpoints
    func listCheckpoints(threadID: String) async throws -> [Checkpoint] {
        let encodedID =
            threadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadID
        let data = try await performJSONRequest(
            method: "GET",
            path: "api/threads/\(encodedID)/checkpoints",
            body: nil
        )
        let response = try JSONDecoder().decode(CheckpointsResponse.self, from: data)
        return response.checkpoints
    }

    /// 从 checkpoint 分叉。POST /api/threads/:id/fork
    ///
    /// 请求体:{ checkpoint_id: ..., title?: ... }
    /// 后端返回新创建 thread 的 ThreadSummary。
    func forkThread(
        threadID: String,
        checkpointID: String,
        title: String?
    ) async throws -> ThreadSummary {
        let encodedID =
            threadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadID

        var bodyDict: [String: Any] = ["checkpoint_id": checkpointID]
        if let title, !title.isEmpty {
            bodyDict["title"] = title
        }
        let bodyData = try JSONSerialization.data(withJSONObject: bodyDict)

        let data = try await performJSONRequest(
            method: "POST",
            path: "api/threads/\(encodedID)/fork",
            body: bodyData
        )

        // ThreadSummary 有 ISO 8601 带毫秒的时间字段,用专用 decoder
        return try ChatAPIClient.makeThreadDecoder().decode(ThreadSummary.self, from: data)
    }

    /// Phase 10.1 #4 — 提交用户反馈。POST /api/feedback
    ///
    /// 请求体协议(和后端 FeedbackRequestBody 对齐):
    ///   { "run_id": "...", "score": 0..1 }
    ///
    /// 这里没用 ChatRequestBody / 也不专门建 struct——字段就两个,
    /// 用 [String: Any] 编码 JSON 反而最直接;String 和 Double 都是 JSON 原生类型,
    /// JSONSerialization 能正确处理。
    ///
    /// 后端成功返回 201 + { feedback_id },但 iOS 这一版**不关心** feedback_id
    /// (用不到——不做撤销也不做去重)。所以这里只 await 不返回值,有错就 throw。
    func submitFeedback(runID: String, score: Double) async throws {
        /**
         * 用 JSONSerialization 而不是 JSONEncoder + struct:
         * - 字段简单(2 个),没必要建 struct
         * - JSONSerialization 能处理 [String: Any],Double / String 都直接序列化为 JSON 数字/字符串
         *
         * 如果未来要加 key / comment 字段,再升级成专用 Encodable struct 不迟。
         */
        let bodyDict: [String: Any] = [
            "run_id": runID,
            "score": score
        ]
        let bodyData = try JSONSerialization.data(withJSONObject: bodyDict)

        _ = try await performJSONRequest(method: "POST", path: "api/feedback", body: bodyData)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase 9 #3 — HITL Resume(续跑挂起的 Agent)
    // ─────────────────────────────────────────────────────────────────────

    /// 续跑挂起的 Agent。POST /api/threads/:id/resume
    ///
    /// 实现要点:
    ///   - URL 不同(挂在 /threads/:id/resume,thread id 在路径里)
    ///   - body 是 { approved, edited_args? },没有 message / history / thread_id
    ///   - 响应仍然是 SSE 流,所以底层调用一个**新的私有方法**
    ///     sendStreamingResumeRequest,和 sendStreamingRequest 共享 SSE 解析代码
    ///
    /// 为什么不直接复用 sendStreamingRequest?
    ///   sendStreamingRequest 的 body 是 ChatRequestBody(为聊天接口设计),
    ///   字段是 message/system_prompt/history/thread_id,跟 resume 完全不重合。
    ///   硬塞会让请求体结构和路由耦合,反而难懂。分两个方法各管各的更清晰。
    func resumeThread(
        threadID: String,
        approved: Bool,
        editedArgs: [String: JSONValue]?
    ) throws -> AsyncThrowingStream<ChatStreamUpdate, Error> {
        sendStreamingResumeRequest(
            threadID: threadID,
            approved: approved,
            editedArgs: editedArgs
        )
    }

    /// resumeThread 的底层 SSE 实现 —— 跟 sendStreamingRequest 的 SSE 解析逻辑
    /// **完全一致**,只是 URL 和 body 不同。这里允许少量重复,因为抽公共部分
    /// 反而要引入回调泛型让代码更难看。
    private func sendStreamingResumeRequest(
        threadID: String,
        approved: Bool,
        editedArgs: [String: JSONValue]?
    ) -> AsyncThrowingStream<ChatStreamUpdate, Error> {
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    // URL path 编码:thread id 一般是 UUID,但万一带特殊字符也得安全
                    let encodedID = threadID.addingPercentEncoding(
                        withAllowedCharacters: .urlPathAllowed
                    ) ?? threadID
                    let url = baseURL.appending(path: "api/threads/\(encodedID)/resume")

                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

                    // 构造 body:approved 必填,edited_args 可选
                    var bodyDict: [String: Any] = ["approved": approved]
                    if let editedArgs {
                        // 把 [String: JSONValue] 编码成普通 Dictionary,
                        // 再用 JSONSerialization 套外层 — JSONValue 自己实现了 Codable,
                        // 所以走两步:先 encode 成 Data,再 JSONSerialization 反解出 Any。
                        let encoded = try JSONEncoder().encode(editedArgs)
                        if let any = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] {
                            bodyDict["edited_args"] = any
                        }
                    }
                    request.httpBody = try JSONSerialization.data(withJSONObject: bodyDict)

                    let (bytes, response) = try await urlSession.bytes(for: request)

                    guard let httpResponse = response as? HTTPURLResponse else {
                        continuation.finish(throwing: ChatAPIError.invalidResponse)
                        return
                    }

                    // 404 = 没 pending、503 = HITL 未启用 等等 — 走错误分支
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
                            throwing: ChatAPIError.serverMessage("Resume 失败,HTTP 状态码:\(httpResponse.statusCode)")
                        )
                        return
                    }

                    // 复用同样的 SSE 解析(逐行 → data: 前缀 → JSON decode → 事件分发)
                    let decoder = JSONDecoder()
                    let dataPrefix = "data:"

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
                            if let delta = event.delta, !delta.isEmpty {
                                continuation.yield(.delta(delta))
                            }
                        case "tool_start":
                            if let toolUpdate = event.agentToolUpdate {
                                continuation.yield(.toolStart(toolUpdate))
                            }
                        case "tool_done":
                            if let toolUpdate = event.agentToolUpdate {
                                continuation.yield(.toolDone(toolUpdate))
                            }
                        case "tool_pending":
                            // 续跑后模型可能再调一个需要审批的工具,二次挂起
                            if let pending = event.pendingApproval {
                                continuation.yield(.toolPending(pending))
                            }
                        case "done":
                            continuation.yield(.done(
                                runID: event.runID,
                                pending: event.pending?.toPendingApproval()
                            ))
                            continuation.finish()
                            return
                        case "error":
                            let message = event.error ?? "Resume 失败,请稍后再试。"
                            continuation.finish(throwing: ChatAPIError.serverMessage(message))
                            return
                        default:
                            continue
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

    /// 4 个对话管理接口共用的 HTTP 底层。
    ///
    /// 它做的事:
    ///   1. 拼 URL
    ///   2. 设 method / Content-Type
    ///   3. (有 body 就)塞请求体
    ///   4. 发请求,检查 HTTP 状态码
    ///   5. 把响应 Data 原样返回,由调用方按自己的 schema 解码
    ///
    /// 不包含 JSON 解码,因为 4 个接口的响应 schema 都不一样
    /// (ThreadSummary / { threads } / { messages } / 空 body)。
    private func performJSONRequest(method: String, path: String, body: Data?) async throws -> Data {
        let url = baseURL.appending(path: path)

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            request.httpBody = body
        }

        let (data, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ChatAPIError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            /**
             * 后端失败时一致返回 { "error": "..." },尝试解码这个 schema 给用户看。
             * 解不出就退回到状态码兜底信息。
             */
            if let errorBody = try? JSONDecoder().decode(ChatErrorResponseBody.self, from: data) {
                throw ChatAPIError.serverMessage(errorBody.error)
            }
            throw ChatAPIError.serverMessage("请求失败,HTTP 状态码:\(httpResponse.statusCode)")
        }

        return data
    }

    /// 专用于 Thread 系列接口的 JSONDecoder。
    ///
    /// 关键点:**ISO 8601 + 毫秒**。
    ///
    /// 后端 Node 的 `Date.prototype.toISOString()` 输出是
    /// `"2026-05-17T08:00:00.000Z"` ——**带 .sss 毫秒部分**。
    ///
    /// 而 JSONDecoder 默认的 .iso8601 策略用的是 ISO8601DateFormatter 的默认配置,
    /// **不识别小数秒**——直接用会抛 dataCorrupted 错误。
    ///
    /// 这里手动创建 ISO8601DateFormatter,带上 .withFractionalSeconds 选项,
    /// 用 .custom 策略喂给 decoder。
    ///
    /// static + 每次新建:JSONDecoder 不是线程安全的 stateful 对象,
    /// 不同请求最好各拿一份;但 formatter 是 thread-safe 的,可以在 closure 里复用。
    private static func makeThreadDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            if let date = formatter.date(from: string) {
                return date
            }
            /**
             * 兜底:如果哪一天后端改成不输出毫秒了(比如换成 PostgreSQL 的 timestamptz),
             * 用一个不带 .withFractionalSeconds 的 formatter 再试一次。
             * 不抛错,优雅降级。
             */
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            if let date = fallback.date(from: string) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "无法解析 ISO 8601 时间字符串:\(string)"
            )
        }
        return decoder
    }
}

/// 对应后端 GET /api/threads 的 { "threads": [...] } 包装层。
///
/// 用 private 而不是放到 Models/ 里,
/// 是因为这个包装结构是"网络协议层细节",
/// UI 层只关心展开后的 [ThreadSummary],不需要知道有这层包装。
private struct ThreadListResponseBody: Decodable {
    let threads: [ThreadSummary]
}

/// 对应后端 GET /api/threads/:id/messages 的 { "messages": [...] } 包装层。
/// 同理,private 收在网络层内部。
private struct ThreadMessagesResponseBody: Decodable {
    let messages: [ThreadMessage]
}

/// iOS 发给 Node.js 的 JSON 请求体。
/// Codable / Encodable 的作用：
/// 让 Swift 结构体可以自动变成 JSON。
private struct ChatRequestBody: Encodable {//- Encodable ≈ Moshi/Gson 的 @Serializable
    // Encodable：这个 Swift 结构体可以被 JSONEncoder 编码成 JSON。
    let message: String
    let systemPrompt: String
    let history: [ChatHistoryItem]

    /// Phase 5.5 新增:对话 id。
    ///
    /// 可选(String?)的原因——和后端 ChatRequestBody.thread_id 字段呼应:
    /// - nil  → JSON 里这个字段直接不出现,后端走 Phase 4 行为(无持久化,靠 history 数组带历史)
    /// - 非 nil → 后端启用 LangGraph checkpointer,自动从 SQLite 加载历史 + 写回新 state
    ///
    /// 配合下方 CodingKeys,默认行为已经满足:
    /// Swift 的 Optional + JSONEncoder 默认 strategy 是"nil 字段不编码",
    /// 所以老路径(threadID = nil)发出的 JSON 完全等价于之前的版本,后端零感知。
    let threadID: String?

    /// Swift 通常用驼峰命名 systemPrompt；
    /// 后端现在用下划线命名 system_prompt。
    /// CodingKeys 用来告诉 JSONEncoder：
    /// Swift 的 systemPrompt 要编码成 JSON 里的 system_prompt。
    enum CodingKeys: String, CodingKey {//把 Swift 驼峰 systemPrompt 映射成 JSON 下划线 system_prompt
        case message
        case systemPrompt = "system_prompt"
        case history
        case threadID = "thread_id"
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
    /// Phase 10.1 #4 — done 事件的 LangSmith 根 run id。
    /// 其它事件类型(delta / tool_*)上不出现,所以是 Optional。
    let runID: String?
    /// Phase 9 #3 — tool_pending 事件携带的工具参数。
    /// 类型 [String: JSONValue] 适配任意 JSON object。
    let args: [String: JSONValue]?
    /// Phase 9 #3 — done 事件可能携带的 pending 描述。
    /// 流式 SSE 已经先发了 tool_pending,这里再带一份是"双保险"。
    let pending: PendingEventPayload?

    enum CodingKeys: String, CodingKey {
        case type
        case delta
        case error
        case toolCallID = "tool_call_id"
        case toolName = "tool_name"
        case displayName = "display_name"
        case message
        case ok
        case runID = "run_id"
        case args
        case pending
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

    /// Phase 9 #3 — 把 tool_pending 事件整理成 PendingApproval。
    /// tool_pending 事件本身的顶层字段就是 PendingApproval 的字段,直接组装。
    var pendingApproval: PendingApproval? {
        guard let toolCallID,
              let toolName,
              let displayName,
              let args else {
            return nil
        }
        return PendingApproval(
            toolCallID: toolCallID,
            toolName: toolName,
            displayName: displayName,
            args: args
        )
    }
}

/// done 事件里嵌套的 pending 对象 — 字段顺序和顶层 tool_pending 完全对齐。
/// 单独建 struct 是因为它出现在 done 事件的 `pending` 字段下,
/// 不能复用 ChatStreamEvent 自己。
private struct PendingEventPayload: Decodable {
    let toolCallID: String
    let toolName: String
    let displayName: String
    let args: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case toolCallID = "tool_call_id"
        case toolName = "tool_name"
        case displayName = "display_name"
        case args
    }

    func toPendingApproval() -> PendingApproval {
        PendingApproval(
            toolCallID: toolCallID,
            toolName: toolName,
            displayName: displayName,
            args: args
        )
    }
}
