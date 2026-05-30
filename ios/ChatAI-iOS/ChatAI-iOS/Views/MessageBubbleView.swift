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

    /// Phase 10.1 #4 — 用户点击 👍/👎 时的回调。
    ///
    /// 参数是 0..1 浮点分数:1 = 👍,0 = 👎。
    ///
    /// 默认是空闭包,这样 Previews 和不需要反馈的场景可以不传。
    /// ChatView 调用时会传一个把 score 转给 ChatViewModel.submitFeedback 的闭包。
    ///
    /// 设计选择:用闭包,而不是直接持有 ChatViewModel。
    /// 理由 = MessageBubbleView 应该是"纯展示组件",不知道 VM 存在;
    /// 解耦后这个 View 也能在别的页面复用(比如未来的"历史回顾"页)。
    var onSubmitFeedback: (Double) -> Void = { _ in }

    /// Phase 9 #8 — 用户在 AI 消息上**长按 → 点[从这里分叉]菜单项**时的回调。
    ///
    /// 实现:在 AI 气泡上挂 .contextMenu(iOS 原生长按弹菜单,不会和气泡的
    /// .textSelection 选文字冲突)。菜单项被点击时调这个闭包。
    ///
    /// 默认空闭包 — 用户消息和 Preview 场景都不需要,ChatView 才传真实回调。
    var onForkRequested: () -> Void = { }

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

            // Phase 10.1 #4 — 反馈按钮放在气泡**外面**(气泡下方),
            // 不挤气泡内部布局;只 AI 消息且 runId 已就位时才显示。
            VStack(alignment: .leading, spacing: 6) {
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
                    // Phase 9 #8 — 给 AI 消息挂 contextMenu(Time-travel 入口)
                    .contextMenu { contextMenuItems }

                feedbackBar
            }
            // 限制气泡最大宽度。
            // 否则在 iPad 或横屏时，一条消息可能会拉得特别长，不好阅读。
            .frame(maxWidth: 560, alignment: isUserMessage ? .trailing : .leading)

            // 右边放 Spacer，气泡就留在左边。
            if !isUserMessage {
                Spacer(minLength: 48)
            }
        }
    }

    /// Phase 10.1 #4 — 反馈按钮条。
    ///
    /// 显示规则:
    ///   - 用户消息 → 永远不显示
    ///   - AI 消息但 runId == nil(流式中 / 后端没启 LangSmith) → 不显示
    ///   - AI 消息且有 runId → 显示 👍/👎
    ///       - 还没反馈过(feedbackScore == nil) → 两个按钮都可点
    ///       - 已反馈过 → 对应按钮高亮,两个都禁用(防重复)
    @ViewBuilder
    private var feedbackBar: some View {
        if !isUserMessage, message.runId != nil {
            HStack(spacing: 12) {
                feedbackButton(
                    systemImage: message.feedbackScore == 1 ? "hand.thumbsup.fill" : "hand.thumbsup",
                    isHighlighted: message.feedbackScore == 1,
                    score: 1
                )
                feedbackButton(
                    systemImage: message.feedbackScore == 0 ? "hand.thumbsdown.fill" : "hand.thumbsdown",
                    isHighlighted: message.feedbackScore == 0,
                    score: 0
                )
            }
            .padding(.leading, 4)
        }
    }

    /// 单个反馈按钮。
    ///
    /// disabled 的判定:已反馈过(feedbackScore != nil)就禁用。
    /// 高亮态(实心图标 + accent 色)用来标示"用户选了哪个"。
    @ViewBuilder
    private func feedbackButton(
        systemImage: String,
        isHighlighted: Bool,
        score: Double
    ) -> some View {
        Button {
            onSubmitFeedback(score)
        } label: {
            Image(systemName: systemImage)
                .font(.footnote)
                .foregroundStyle(isHighlighted ? Color.accentColor : Color.secondary)
        }
        // 已经反馈过就禁用,防止重复提交。
        // 注意:这是"已反馈任何分数后两个按钮都禁用",
        // 不是"只有自己被点过才禁"——一次回答只允许一个分数,
        // 想改就要先撤销(目前 UI 不支持撤销,留给后续迭代)。
        .disabled(message.feedbackScore != nil)
        // BorderlessButton 在 List/ScrollView 里能避免"整行被识别为点击"的问题,
        // 让点击事件精准命中图标本身。
        .buttonStyle(.borderless)
    }

    /// Phase 9 #8 — 长按 AI 消息弹出的菜单项(Time-travel 入口)。
    ///
    /// 用户消息的菜单为空(不显示分叉),所以这里用 ViewBuilder + isUserMessage 判断。
    /// 空 ViewBuilder 时 SwiftUI 会自动不显示 contextMenu(用户长按没反应)。
    @ViewBuilder
    private var contextMenuItems: some View {
        if !isUserMessage {
            Button {
                onForkRequested()
            } label: {
                // 系统图标 "arrow.triangle.branch" 视觉上就是 git 分支的样子,
                // 让用户一眼明白这是"从这里分叉"
                Label("从这里分叉", systemImage: "arrow.triangle.branch")
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
