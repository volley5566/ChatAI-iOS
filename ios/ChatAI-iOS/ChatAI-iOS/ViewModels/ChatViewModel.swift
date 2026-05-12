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
    func sendMessage() async {
        let messageText = trimmedInputText

        guard !messageText.isEmpty else {
            return
        }

        /// 先把用户输入追加到聊天列表。
        /// 这样用户点击发送后，能马上看到自己的消息。
        messages.append(
            ChatMessage(role: .user, content: messageText)
        )

        /// 清空输入框，避免用户重复发送同一段内容。
        inputText = ""
        errorMessage = nil
        isSending = true

        do {
            /// 调用网络层，请求 Node.js 后端。
            let answer = try await chatAPI.sendMessage(
                messageText,
                systemPrompt: AppConfig.defaultSystemPrompt
            )

            /// 后端成功返回后，把 AI 回答追加到消息列表。
            messages.append(
                ChatMessage(role: .assistant, content: answer)
            )
        } catch {
            /// 出错时不崩溃，而是把错误显示在页面上。
            errorMessage = error.localizedDescription
        }

        isSending = false
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
}
