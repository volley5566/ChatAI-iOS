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
    /// AI 消息：
    /// - 如果有 Agent 工具步骤，先显示工具执行状态
    /// - 优先显示结构化回答
    /// - 如果没有结构化回答，就显示普通文字
    @ViewBuilder
    private var messageContent: some View {
        if isUserMessage {
            Text(message.content)
                .font(.body)
                .foregroundStyle(.white)
        } else if let structuredAnswer = message.structuredAnswer {
            VStack(alignment: .leading, spacing: 8) {
                agentToolStepsView
                StructuredAnswerView(answer: structuredAnswer)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                agentToolStepsView

                if !message.content.isEmpty {
                    Text(message.content)
                        .font(.body)
                        .foregroundStyle(.primary)
                }
            }
        }
    }

    /// Agent 工具执行状态。
    ///
    /// 这些状态来自后端 SSE：
    /// - tool_start：显示“正在...”
    /// - tool_done：显示“已完成...”
    ///
    /// 它们放在 AI 气泡内部，表示这是当前回答生成过程的一部分。
    @ViewBuilder
    private var agentToolStepsView: some View {
        if !message.agentToolSteps.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(message.agentToolSteps) { step in
                    HStack(spacing: 6) {
                        toolStatusIcon(for: step.status)
                            .font(.caption)
                            .frame(width: 14, height: 14)

                        Text(step.message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// 根据工具状态切换图标。
    @ViewBuilder
    private func toolStatusIcon(for status: AgentToolStepStatus) -> some View {
        switch status {
        case .running:
            ProgressView()
                .scaleEffect(0.55)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
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
                    ),
                    agentToolSteps: [
                        AgentToolStep(
                            id: "call_1",
                            toolName: "searchKnowledge",
                            displayName: "查询知识库",
                            status: .completed,
                            message: "已查询知识库，找到 2 条相关资料"
                        )
                    ]
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
