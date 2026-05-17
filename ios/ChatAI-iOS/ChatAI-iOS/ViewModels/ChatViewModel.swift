//
//  ChatViewModel.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import Combine
import Foundation

/// ChatViewModel 是聊天页面的“大脑”。
///
/// ViewModel 不直接写 UI，也不直接关心按钮长什么样。
/// 它负责：
/// - 保存输入框内容
/// - 保存聊天消息列表
/// - 调用网络层发送消息
/// - 控制 loading / error 状态
///
/// @MainActor 表示这个类里的状态更新都在主线程执行。
/// SwiftUI 的页面状态应该在主线程更新，这样最安全。
/// 这个类里面的状态更新，都应该在主线程执行。
@MainActor
// final：这个类不能被继承。
// ObservableObject：这个对象可以被 SwiftUI 观察，View 可以观察这个 ViewModel。
final class ChatViewModel: ObservableObject {
    /// Phase 5.5.5 — 当前对话的 thread id。
    ///
    /// 生命周期:
    ///   - 初始为 nil(还没发任何消息)
    ///   - 用户点击发送第一条消息时,sendMessage() 会先调 createThread() 拿到 id 存进来
    ///   - 后续消息一律带这个 id 发,后端的 checkpointer 负责持久化
    ///   - resetConversation() 会把它清回 nil,等于"开始一段新对话"
    ///
    /// 为什么用 private var,不用 @Published?
    ///   5.5 阶段没有 UI 直接观察它(对话列表 UI 是 5.6 的事)。
    ///   暂时只供 ViewModel 自己用,保持 private 最简单。
    ///   5.6 引入对话列表时,如果需要顶部显示"当前对话 xxx",再升级成 @Published。
    private var currentThreadID: String?

    /// 聊天消息列表。页面会根据它自动刷新。
    /// @Published：这个变量一变化，就通知 SwiftUI 页面刷新。
    @Published var messages: [ChatMessage] = [
        ChatMessage(
            role: .assistant,
            content: "你好，我是你的 AI 助手。你可以问我 SwiftUI、iOS 或 AI 应用开发相关的问题。"
        )
    ]

    /// 输入框当前文字。
    /// @Published：这个变量一变化，就通知 SwiftUI 页面刷新。
    @Published var inputText = ""

    /// 是否正在等待后端返回。
    /// 为 true 时，按钮会禁用，并显示发送中的状态。
    /// 表示当前是否正在发送请求 / 等待 AI 回复
    ///
    /// isSending = true
    ///     输入框禁用
    ///     发送按钮禁用
    ///     显示 loading
    ///     清空按钮禁用
    ///
    /// isSending = false
    ///     恢复正常输入和发送
    /// @Published：这个变量一变化，就通知 SwiftUI 页面刷新。
    @Published var isSending = false

    /// 当前错误提示。
    /// 有值时，页面会显示一条红色提示。
    /// @Published：这个变量一变化，就通知 SwiftUI 页面刷新。
    @Published var errorMessage: String?

    // 这个是网络层接口：
    //
    // View
    //   ↓
    // ViewModel
    //   ↓
    // ChatAPI 协议
    //   ↓
    // ChatAPIClient 实现
    //   ↓
    // Node.js 后端 / AI 接口
    private let chatAPI: ChatAPI

    /// 如果外部传了 chatAPI，就用外部传进来的。
    /// 如果外部没传，就默认用 ChatAPIClient()。
    init(chatAPI: ChatAPI? = nil) {
        // 这里不直接把 ChatAPIClient() 写在参数默认值里，
        // 是为了避开 Swift 并发隔离下的一个默认参数警告。
        // 简单理解：默认参数会在 init 外面先计算；
        // 写在 init 里面更符合这个 ViewModel 的主线程上下文。
        self.chatAPI = chatAPI ?? ChatAPIClient()
    }

    /// 发送按钮是否可以点击。
    ///
    /// 规则：
    /// - 输入框不能为空
    /// - 当前没有正在发送的请求
    ///
    /// 这个是计算属性
    /// 它不是保存一个值，而是每次访问时动态计算
    var canSendMessage: Bool {
        !trimmedInputText.isEmpty && !isSending
    }

    /// 点击发送按钮后调用。
    ///
    /// 当前默认走“Agent 流式输出”：
    /// - 用户消息立即追加到列表
    /// - 再追加一条空的 assistant 消息
    /// - 后端先完成 Tool Calling 阶段
    /// - 后端再把最终回答通过 SSE 返回
    /// - 每收到一个 delta，就更新这条 assistant 消息的 content
    ///
    /// 普通流式接口和结构化接口仍然保留在 ChatAPIClient 里，
    /// 方便后续做对比测试或“最终结构化卡片”升级。
    /// 它是异步函数，因为里面要请求后端、处理流式返回
    ///
    /// 用户点击发送
    ///    ↓
    /// sendMessage()
    ///    ↓
    /// 取出输入框文字并 trim
    ///    ↓
    /// 如果为空，直接 return
    ///    ↓
    /// 整理历史消息 history
    ///    ↓
    /// 把用户消息 append 到 messages
    ///    ↓
    /// 清空输入框
    ///    ↓
    /// errorMessage = nil
    ///    ↓
    /// isSending = true
    ///    ↓
    /// 创建流式请求 stream
    ///    ↓
    /// 先 append 一条空的 assistant 消息
    ///    ↓
    /// 不断接收后端 SSE update
    ///    ↓
    /// 收到 delta：更新 assistant content
    ///    ↓
    /// 收到 toolStart：更新工具步骤 running
    ///    ↓
    /// 收到 toolDone：更新工具步骤 completed / failed
    ///    ↓
    /// 结束后如果没内容，抛 emptyAnswer
    ///    ↓
    /// 如果出错，显示 errorMessage
    ///    ↓
    /// defer 自动 isSending = false
    func sendMessage() async {
        // 第一步：取出输入内容。
        let messageText = trimmedInputText

        // 如果输入为空，就直接退出，不发送。
        //guard 是 Swift 的"提前 return"语法。条件不成立直接退出,类似 Kotlin 的 ?: return
        guard !messageText.isEmpty else {
            return
        }

        // 先把用户输入追加到聊天列表。
        // 这样用户点击发送后，能马上看到自己的消息。
        // 第二步：先显示用户消息
        messages.append(
            // 用户一点发送，就马上把用户消息追加到列表。
            ChatMessage(role: .user, content: messageText)
        )

        // 第三步：清空输入框，设置状态。
        // 清空输入框，避免用户重复发送同一段内容。
        inputText = ""
        errorMessage = nil
        isSending = true

        // 用 defer 保证函数退出时一定恢复发送状态。
        //
        // 流式输出里可能出现几种退出路径：
        // - 正常收到 done
        // - 网络错误
        // - 后端 SSE error
        // - JSON 解析错误
        //
        // 如果每个分支都手动写 isSending = false，
        // 后续维护时很容易漏掉某个分支。
        // defer：不管这个函数后面怎么结束，离开函数前都执行这段代码。
        defer {
            isSending = false
        }

        // 两个临时变量
        // 这两个变量是为了处理流式回答。
        var assistantMessageID: UUID?
        // 它用来累计所有返回片段。
        var streamedAnswer = ""

        do {
            // Phase 5.5.5 — 确保 thread 存在。
            //
            // 如果 currentThreadID 还是 nil(这是用户首次发消息),
            // 先调后端 POST /api/threads 拿一个新 id 存进来。
            // 之后这次以及后续所有消息,都会带着同一个 id 发,
            // 后端 checkpointer 会自动管理历史。
            //
            // 失败处理:createThread 抛错会直接进入下面的 catch,
            // 显示错误,不会带着 nil threadID fallback 到老路径——
            // 那种 fallback 会让用户以为消息发出去了,实际后续找不回,体验是错乱的。
            if currentThreadID == nil {
                let thread = try await chatAPI.createThread(title: nil)
                currentThreadID = thread.id
            }

            // 调用网络层，请求 Node.js Agent 流式接口。
            //
            // sendAgentStreamingMessage 返回的不是完整答案，
            // 而是一个 AsyncThrowingStream<ChatStreamUpdate, Error>。
            //
            // 后端会先做 Tool Calling：
            // 模型决定是否调用 searchKnowledge / generateQuiz，
            // 后端执行工具并把结果交回模型。
            //
            // 工具阶段会通过 tool_start / tool_done 告诉 iOS 当前进度。
            // 工具阶段完成后，最终回答才会通过 delta 一段段推给 iOS。
            //
            // history 固定传空数组——后端拿到 thread_id 时,
            // 只会用请求里的 message 字段,完整历史从 checkpointer 加载。
            // 继续传 history 是浪费带宽,而且会让"历史的真相在哪"变得不清晰。
            let stream = try chatAPI.sendAgentStreamingMessage(//调网络层拿流式接口 AsyncThrowingStream类似 Kotlin 的 Flow<T>
                messageText,
                systemPrompt: AppConfig.defaultSystemPrompt,
                history: [],
                threadID: currentThreadID
            )

            // 先追加一条空的 AI 消息，给后续 delta 一个固定容器。
            //
            // 这条消息的 id 会被保存下来。
            // 后面每收到一段 delta，都通过这个 id 找到同一条消息并替换 content。
            //
            // 用户消息已经显示了
            //    ↓
            // 马上追加一个空的 AI 消息气泡
            //    ↓
            // 后面流式内容来了
            //    ↓
            // 不断更新这个空气泡
            //后面每收到一段 delta,不是 append 新消息,而是用 ID 找到这条空气泡然后替换 content。这样列表始终是"用户一条 → AI 一条",不会变成"用户一条 → AI 片段 1 → AI 片段 2 → AI 片段 3"。
            let assistantMessage = ChatMessage(role: .assistant, content: "")// 空气泡 就是这里创建了一个空的气泡 然后后续内容就往里添加即可
            assistantMessageID = assistantMessage.id// 记下 ID
            messages.append(assistantMessage)

            // 这个就是读取流式数据。
            //
            // 后端每推送一条 SSE 事件，这里就循环一次。
            // 可能收到三种 update：
            // delta       AI 正文片段
            // toolStart   工具开始执行
            // toolDone    工具执行完成
            for try await update in stream {//for try await ... in stream 是 Swift 异步序列的"消费方式" 等于 Kotlin 的 flow.collect { update -> ... }
                switch update {
                case .delta(let delta):// 文本片段
                    //收到 delta:累积并更新 UI
                    streamedAnswer += delta

                    if let assistantMessageID {
                        updateMessageContent(
                            id: assistantMessageID,
                            content: streamedAnswer
                        )
                    }

                case .toolStart(let toolUpdate):// 工具开始
                    if let assistantMessageID {
                        updateAgentToolStep(
                            messageID: assistantMessageID,
                            update: toolUpdate,
                            status: .running
                        )
                    }

                case .toolDone(let toolUpdate):// 工具结束
                    if let assistantMessageID {
                        updateAgentToolStep(
                            messageID: assistantMessageID,
                            update: toolUpdate,
                            status: toolUpdate.ok == false ? .failed : .completed
                        )
                    }
                }
            }

            // 如果后端正常结束，但没有任何文本片段，
            // 这通常表示模型返回异常或上游没有输出内容。
            // 这里复用已有 emptyAnswer 错误，给用户一个明确提示。
            if streamedAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw ChatAPIError.emptyAnswer
            }
        } catch {
            // 如果错误发生在还没收到任何 delta 之前，
            // 页面上会留下一个空白 AI 气泡。
            // 这种气泡没有信息量，所以直接移除。
            //
            // 如果已经收到部分内容，则保留 partial answer，
            // 同时显示错误提示，方便用户知道回答中途断了。
            if streamedAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let assistantMessageID {
                messages.removeAll { $0.id == assistantMessageID }
            }

            // 出错时不崩溃，而是把错误显示在页面上。
            errorMessage = error.localizedDescription
        }
    }

    /// 清空聊天记录，保留一条欢迎语。
    ///
    /// Phase 5.5.5 起,"清空"按钮的语义升级为"开始一段新对话":
    ///   - 把 currentThreadID 切回 nil → 下次发消息会调 createThread 拿新 id
    ///   - 不调 deleteThread——历史 thread 还在数据库里,
    ///     5.6 的对话列表 UI 可以让用户回到那个对话
    func resetConversation() {
        messages = [
            ChatMessage(
                role: .assistant,
                content: "聊天已清空。你可以继续问我新的问题。"
            )
        ]
        inputText = ""
        errorMessage = nil
        isSending = false
        currentThreadID = nil
    }

    /// 去掉输入框前后的空格和换行。
    /// 用户只输入空格时，也会被当成空消息。
    private var trimmedInputText: String {
        inputText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 更新某一条消息的正文。
    ///
    /// 流式输出时，后端会持续返回 delta。
    /// 我们不追加新消息，而是不断替换同一条 assistant 消息的 content。
    ///
    /// 这样聊天列表始终保持：
    /// 用户一条消息 -> AI 一条消息
    ///
    /// 而不是：
    /// 用户一条消息 -> AI 片段 1 -> AI 片段 2 -> AI 片段 3
    private func updateMessageContent(id: UUID, content: String) {
        // 根据 id 找到 messages 里对应的消息下标。
        // 如果找不到，直接 return。
        // 如果找到了，用新的 content 替换它。
        guard let index = messages.firstIndex(where: { $0.id == id }) else {
            return
        }

        messages[index] = messages[index].updatingContent(content)
    }

    /// 更新某条 AI 消息里的 Agent 工具执行步骤。
    ///
    /// tool_start 和 tool_done 使用同一个 toolCallID。
    /// 如果已经存在对应步骤，就更新状态和文案；
    /// 如果不存在，就追加一条新步骤。
    ///
    /// 这样 UI 能展示：
    /// - 正在查询知识库
    /// - 已查询知识库，找到 2 条相关资料
    private func updateAgentToolStep(
        messageID: UUID,
        update: AgentToolUpdate,
        status: AgentToolStepStatus
    ) {
        // 先在 messages 里找到当前那条 assistant 消息。
        // 找不到就直接退出。
        guard let messageIndex = messages.firstIndex(where: { $0.id == messageID }) else {
            return
        }

        // 创建 AgentToolStep。
        // 这里把后端返回的 AgentToolUpdate 转成 UI 使用的 AgentToolStep。
        //
        // AgentToolUpdate：
        // 后端流式事件里的工具更新数据。
        //
        // AgentToolStep：
        // 前端消息气泡里展示的工具步骤。
        let step = AgentToolStep(
            id: update.toolCallID,
            toolName: update.toolName,
            displayName: update.displayName,
            status: status,
            message: update.message
        )

        // 取出已有 steps，一条 AI 消息里可以有多个工具步骤。
        var steps = messages[messageIndex].agentToolSteps

        // 如果已有，就更新；如果没有，就追加。
        if let stepIndex = steps.firstIndex(where: { $0.id == step.id }) {
            steps[stepIndex] = step
        } else {
            steps.append(step)
        }

        // 写回 messages。
        messages[messageIndex] = messages[messageIndex].updatingAgentToolSteps(steps)
    }
}
