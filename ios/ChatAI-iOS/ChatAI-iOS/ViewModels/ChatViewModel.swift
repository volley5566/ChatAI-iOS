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
@MainActor
final class ChatViewModel: ObservableObject {
    /// 每次请求最多带几条历史消息。
    ///
    /// 只带最近 6 条，是为了避免聊天越久，请求内容无限变大。
    /// 最近 6 条通常可以覆盖 3 轮问答，足够处理：
    /// “请更详细回答”“继续”“举个例子”这类追问。
    private let maxHistoryMessages = 6

    /// 聊天消息列表。页面会根据它自动刷新。
    @Published var messages: [ChatMessage] = [
        ChatMessage(
            role: .assistant,
            content: "你好，我是你的 AI 助手。你可以问我 SwiftUI、iOS 或 AI 应用开发相关的问题。"
        )
    ]

    /// 输入框当前文字。
    @Published var inputText = ""

    /// 是否正在等待后端返回。
    /// 为 true 时，按钮会禁用，并显示发送中的状态。
    @Published var isSending = false

    /// 当前错误提示。
    /// 有值时，页面会显示一条红色提示。
    @Published var errorMessage: String?

    private let chatAPI: ChatAPI

    init(chatAPI: ChatAPI? = nil) {
        /// 这里不直接把 ChatAPIClient() 写在参数默认值里，
        /// 是为了避开 Swift 并发隔离下的一个默认参数警告。
        /// 简单理解：默认参数会在 init 外面先计算；
        /// 写在 init 里面更符合这个 ViewModel 的主线程上下文。
        self.chatAPI = chatAPI ?? ChatAPIClient()
    }

    /// 发送按钮是否可以点击。
    ///
    /// 规则：
    /// - 输入框不能为空
    /// - 当前没有正在发送的请求
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
    func sendMessage() async {
        let messageText = trimmedInputText

        guard !messageText.isEmpty else {
            return
        }

        /// 在追加当前用户消息之前，先整理历史。
        /// 因为当前 message 会单独作为 message 字段发给后端，
        /// history 里只需要放“之前发生过的对话”。
        let history = recentHistoryItems()

        /// 先把用户输入追加到聊天列表。
        /// 这样用户点击发送后，能马上看到自己的消息。
        messages.append(
            ChatMessage(role: .user, content: messageText)
        )

        /// 清空输入框，避免用户重复发送同一段内容。
        inputText = ""
        errorMessage = nil
        isSending = true

        /**
         用 defer 保证函数退出时一定恢复发送状态。

         流式输出里可能出现几种退出路径：
         - 正常收到 done
         - 网络错误
         - 后端 SSE error
         - JSON 解析错误

         如果每个分支都手动写 isSending = false，
         后续维护时很容易漏掉某个分支。
         */
        defer {
            isSending = false
        }

        var assistantMessageID: UUID?
        var streamedAnswer = ""

        do {
            /// 调用网络层，请求 Node.js Agent 流式接口。
            ///
            /// sendAgentStreamingMessage 返回的不是完整答案，
            /// 而是一个 AsyncThrowingStream<ChatStreamUpdate, Error>。
            ///
            /// 后端会先做 Tool Calling：
            /// 模型决定是否调用 searchKnowledge / generateQuiz，
            /// 后端执行工具并把结果交回模型。
            ///
            /// 工具阶段会通过 tool_start / tool_done 告诉 iOS 当前进度。
            /// 工具阶段完成后，最终回答才会通过 delta 一段段推给 iOS。
            let stream = try chatAPI.sendAgentStreamingMessage(
                messageText,
                systemPrompt: AppConfig.defaultSystemPrompt,
                history: history
            )

            /**
             先追加一条空的 AI 消息，给后续 delta 一个固定容器。

             这条消息的 id 会被保存下来。
             后面每收到一段 delta，都通过这个 id 找到同一条消息并替换 content。
             */
            let assistantMessage = ChatMessage(role: .assistant, content: "")
            assistantMessageID = assistantMessage.id
            messages.append(assistantMessage)

            for try await update in stream {
                switch update {
                case .delta(let delta):
                    streamedAnswer += delta

                    if let assistantMessageID {
                        updateMessageContent(
                            id: assistantMessageID,
                            content: streamedAnswer
                        )
                    }

                case .toolStart(let toolUpdate):
                    if let assistantMessageID {
                        updateAgentToolStep(
                            messageID: assistantMessageID,
                            update: toolUpdate,
                            status: .running
                        )
                    }

                case .toolDone(let toolUpdate):
                    if let assistantMessageID {
                        updateAgentToolStep(
                            messageID: assistantMessageID,
                            update: toolUpdate,
                            status: toolUpdate.ok == false ? .failed : .completed
                        )
                    }
                }
            }

            /**
             如果后端正常结束，但没有任何文本片段，
             这通常表示模型返回异常或上游没有输出内容。
             这里复用已有 emptyAnswer 错误，给用户一个明确提示。
             */
            if streamedAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw ChatAPIError.emptyAnswer
            }
        } catch {
            /**
             如果错误发生在还没收到任何 delta 之前，
             页面上会留下一个空白 AI 气泡。
             这种气泡没有信息量，所以直接移除。
             *
             如果已经收到部分内容，则保留 partial answer，
             同时显示错误提示，方便用户知道回答中途断了。
             */
            if streamedAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let assistantMessageID {
                messages.removeAll { $0.id == assistantMessageID }
            }

            /// 出错时不崩溃，而是把错误显示在页面上。
            errorMessage = error.localizedDescription
        }
    }

    /// 清空聊天记录，保留一条欢迎语。
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
    }

    /// 去掉输入框前后的空格和换行。
    /// 用户只输入空格时，也会被当成空消息。
    private var trimmedInputText: String {
        inputText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 整理最近几条历史消息，发送给后端。
    ///
    /// 这里会排除最开始那条欢迎语。
    ///
    /// 为什么用 dropFirst？
    /// messages 第一条是 App 自己放进去的欢迎语，
    /// 它不是用户和 AI 的真实问答内容。
    ///
    /// 流式输出后，assistant 消息可能没有 structuredAnswer，
    /// 但它的 content 就是真实 AI 回答。
    /// 所以不能再只用 structuredAnswer 判断 AI 消息是否可进入历史。
    private func recentHistoryItems() -> [ChatHistoryItem] {
        messages
            .dropFirst()
            .filter { message in
                !message.toHistoryItem().content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            .suffix(maxHistoryMessages)
            .map { $0.toHistoryItem() }
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
        guard let messageIndex = messages.firstIndex(where: { $0.id == messageID }) else {
            return
        }

        let step = AgentToolStep(
            id: update.toolCallID,
            toolName: update.toolName,
            displayName: update.displayName,
            status: status,
            message: update.message
        )

        var steps = messages[messageIndex].agentToolSteps

        if let stepIndex = steps.firstIndex(where: { $0.id == step.id }) {
            steps[stepIndex] = step
        } else {
            steps.append(step)
        }

        messages[messageIndex] = messages[messageIndex].updatingAgentToolSteps(steps)
    }
}
