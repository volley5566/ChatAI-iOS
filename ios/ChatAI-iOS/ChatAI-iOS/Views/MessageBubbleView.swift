//
//  MessageBubbleView.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import SwiftUI

/// 单条聊天气泡。
///
/// 这个 View 只负责显示一条消息。
/// 它不负责网络请求，也不负责保存消息数组。
struct MessageBubbleView: View {
    let message: ChatMessage

    private var isUserMessage: Bool {
        message.role == .user
    }

    var body: some View {
        HStack {
            /// 用户消息靠右，AI 消息靠左。
            if isUserMessage {
                Spacer(minLength: 48)
            }

            messageContent
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(bubbleBackground)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .textSelection(.enabled)
                .frame(maxWidth: 560, alignment: isUserMessage ? .trailing : .leading)

            if !isUserMessage {
                Spacer(minLength: 48)
            }
        }
    }

    /// 根据消息来源切换气泡颜色。
    @ViewBuilder
    private var bubbleBackground: some View {
        if isUserMessage {
            Color.accentColor
        } else {
            Color(.secondarySystemBackground)
        }
    }

    /// 气泡里的内容。
    ///
    /// 用户消息：显示普通文字。
    /// AI 消息：优先显示结构化回答；如果没有结构化回答，就显示普通文字。
    @ViewBuilder
    private var messageContent: some View {
        if !isUserMessage, let structuredAnswer = message.structuredAnswer {
            StructuredAnswerView(answer: structuredAnswer)
        } else {
            Text(message.content)
                .font(.body)
                .foregroundStyle(isUserMessage ? .white : .primary)
        }
    }
}

#if DEBUG
struct MessageBubbleView_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 12) {
            MessageBubbleView(
                message: ChatMessage(
                    role: .assistant,
                    content: "这是 AI 的回答。",
                    structuredAnswer: StructuredAnswer(
                        title: "SwiftUI 是什么",
                        summary: "SwiftUI 是 Apple 提供的声明式 UI 框架。",
                        points: ["用 View 描述界面", "用状态驱动 UI 自动刷新"],
                        nextQuestion: "你想继续了解 @State 吗？"
                    )
                )
            )
            MessageBubbleView(
                message: ChatMessage(role: .user, content: "这是用户的问题。")
            )
        }
        .padding()
    }
}
#endif
