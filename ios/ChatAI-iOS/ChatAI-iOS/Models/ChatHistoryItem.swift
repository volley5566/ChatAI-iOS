//
//  ChatHistoryItem.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/13.
//

import Foundation

/// 发给后端的“历史消息”。
///
/// 注意：
/// ChatMessage 是给 SwiftUI 页面显示用的模型，
/// 它里面有 id、structuredAnswer 等 UI 需要的信息。
///
/// ChatHistoryItem 是给后端接口用的模型，
/// 它只保留 AI API 需要的两个字段：
/// - role：这句话是谁说的，user 或 assistant
/// - content：这句话的纯文本内容
struct ChatHistoryItem: Encodable, Equatable {
    let role: String
    let content: String
}
