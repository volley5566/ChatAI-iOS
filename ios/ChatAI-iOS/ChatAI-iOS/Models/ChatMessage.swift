//
//  ChatMessage.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import Foundation

/// 一条聊天消息是谁发出的。
///
/// user：用户发出的消息
/// assistant：AI 返回的消息
enum ChatMessageRole: String {
    case user
    case assistant
}

/// App 页面中显示的一条聊天消息。
///
/// 注意：这个模型只给 iOS 页面显示使用。
/// 后端接口真正需要的 JSON 请求体，放在 ChatAPIClient.swift 里。
struct ChatMessage: Identifiable, Equatable {
    /// SwiftUI 的 ForEach 需要每条数据都有稳定的 id。
    /// UUID 会自动生成一个唯一值，适合这种本地临时消息。
    let id: UUID

    /// 这条消息是用户发的，还是 AI 发的。
    let role: ChatMessageRole

    /// 消息正文。
    ///
    /// 对用户消息来说，这就是用户输入的内容。
    /// 对 AI 消息来说，它可以作为 fallback：
    /// 如果 structuredAnswer 为空，就显示 content。
    let content: String

    /// AI 的结构化回答。
    ///
    /// 只有 assistant 消息才会有这个值。
    /// 用户消息不需要结构化展示，所以保持 nil。
    let structuredAnswer: StructuredAnswer?

    init(
        role: ChatMessageRole,
        content: String,
        structuredAnswer: StructuredAnswer? = nil,
        id: UUID = UUID()
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.structuredAnswer = structuredAnswer
    }

    /// 返回一条“正文已更新，但 id / role / structuredAnswer 保持不变”的消息。
    ///
    /// 流式输出时，AI 回答会一小段一小段到达。
    /// SwiftUI 的列表依赖 id 判断“这是不是同一条消息”。
    ///
    /// 如果每次 delta 都生成一个全新的 UUID：
    /// - UI 会认为这是新消息
    /// - 滚动和动画可能变得不稳定
    ///
    /// 所以更新流式气泡时，要保留原来的 id，只替换 content。
    func updatingContent(_ newContent: String) -> ChatMessage {
        ChatMessage(
            role: role,
            content: newContent,
            structuredAnswer: structuredAnswer,
            id: id
        )
    }

    /// 转成后端接口需要的历史消息。
    ///
    /// 用户消息直接使用用户输入的 content。
    /// AI 消息优先使用 structuredAnswer 整理出的纯文本，
    /// 这样后端不用理解 iOS 的 UI 结构，也能看懂上一轮 AI 回答。
    func toHistoryItem() -> ChatHistoryItem {
        ChatHistoryItem(
            role: role.rawValue,
            content: historyContent
        )
    }

    /// 用于发送给后端的纯文本内容。
    private var historyContent: String {
        if let structuredAnswer {
            return structuredAnswer.historyContent
        }

        return content
    }
}
