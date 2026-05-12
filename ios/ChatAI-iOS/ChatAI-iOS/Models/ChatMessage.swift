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
enum ChatMessageRole {
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
    let id = UUID()

    /// 这条消息是用户发的，还是 AI 发的。
    let role: ChatMessageRole

    /// 消息正文。
    let content: String
}
