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
    /// 给我一条 ChatMessage，我负责把它显示成聊天气泡。
    let message: ChatMessage

    /// 这个值后面会决定三件事：
    /// 1. 气泡靠左还是靠右
    /// 2. 气泡背景颜色
    /// 3. 气泡里面文字颜色
    ///
    /// isUserMessage 判断这条消息是不是用户发的。
    private var isUserMessage: Bool {
        message.role == .user
    }

    var body: some View {
        HStack {
            // 用户消息靠右，AI 消息靠左。左边放 Spacer，气泡就被推到右边。
            if isUserMessage {
                Spacer(minLength: 48)
            }

            // 气泡样式。
            messageContent
                // 给气泡内部加 padding，也就是文字不要紧贴边缘。
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                // 设置气泡背景。
                .background(bubbleBackground)
                // 把背景裁成圆角矩形。
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                // 允许用户长按/拖选复制文字。
                // 这个对 AI Chat 很重要，因为用户经常要复制 AI 回复。
                .textSelection(.enabled)
                // 限制气泡最大宽度。
                // 否则在 iPad 或横屏时，一条消息可能会拉得特别长，不好阅读。
                .frame(maxWidth: 560, alignment: isUserMessage ? .trailing : .leading)

            // 右边放 Spacer，气泡就留在左边。
            if !isUserMessage {
                Spacer(minLength: 48)
            }
        }
    }

    /// 根据消息来源切换气泡颜色。
    @ViewBuilder
    private var bubbleBackground: some View {
        if isUserMessage {
            // 用户消息：使用 App 的强调色。
            Color.accentColor
        } else {
            // AI 消息：使用系统二级背景色。
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
    ///
    /// @ViewBuilder 允许你在一个 View 返回位置里写 if / else / switch，
    /// 并且不同分支可以返回不同类型的 View。
    /// 如果没有 @ViewBuilder，Swift 会更严格，要求返回类型完全一致。
    @ViewBuilder
    private var messageContent: some View {
        if isUserMessage {
            // 情况 1：用户消息，显示普通文字。
            Text(message.content)
                .font(.body)
                .foregroundStyle(.white)
        } else if let structuredAnswer = message.structuredAnswer {
            // 情况 2：AI 消息，并且有 structuredAnswer。
            // 先显示 Agent 工具步骤，再显示 StructuredAnswerView。
            VStack(alignment: .leading, spacing: 8) {
                agentToolStepsView
                StructuredAnswerView(answer: structuredAnswer)
            }
        } else {
            // 情况 3：AI 消息，但没有 structuredAnswer。
            // 先显示 Agent 工具步骤，再显示普通文本 content。
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
    /// - 正在查询知识库...
    /// - 已查询知识库，找到 2 条相关资料
    /// - 正在调用工具...
    /// - 工具调用失败...
    /// 它们放在 AI 气泡内部，表示这是当前回答生成过程的一部分。
    @ViewBuilder
    private var agentToolStepsView: some View {
        if !message.agentToolSteps.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                // 一条 AI 消息里可以有多个工具步骤。
                // 每个步骤显示一个图标 + 一段文字。
                // ✅ 已查询知识库，找到 2 条相关资料
                // ⏳ 正在生成答案
                // ❌ 工具调用失败
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
            // 显示 loading。
            ProgressView()
                .scaleEffect(0.55)
        case .completed:
            // 显示绿色完成图标。
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            // 显示红色失败图标。
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
