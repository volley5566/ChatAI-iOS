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

/// Agent 工具执行步骤的状态。
///
/// running：工具正在执行
/// completed：工具执行成功
/// failed：工具执行失败
enum AgentToolStepStatus: Equatable {
    case running
    case completed
    case failed
}

/// 一条 Agent 工具执行记录。
///
/// 它不是聊天历史的一部分，而是 UI 辅助信息：
/// 用来告诉用户 AI 当前调用了哪个工具、工具是否完成。
struct AgentToolStep: Identifiable, Equatable {
    /// 后端 SSE 里传来的 tool_call_id。
    ///
    /// 同一个工具可能在一次回答里被调用多次。
    /// 用 toolCallID 可以精确更新对应那一步，而不是只靠工具名猜。
    let id: String

    let toolName: String
    let displayName: String
    let status: AgentToolStepStatus
    let message: String
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

    /// Agent 工具执行过程。
    ///
    /// 普通聊天消息为空。
    /// Agent 回答时，如果后端发送 tool_start / tool_done 事件，
    /// ViewModel 会把这些事件整理成步骤展示在 AI 气泡里。
    let agentToolSteps: [AgentToolStep]

    /// Phase 10.1 #4 — LangSmith trace 的根 run id。
    ///
    /// 只 assistant 消息可能有这个值,且要等后端 SSE 发出 done 事件后才填上——
    /// 在那之前(流式输出过程中)是 nil。
    ///
    /// MessageBubbleView 根据它判定要不要显示 👍/👎 反馈按钮:
    ///   - nil  → 不显示(还在流式 / 用户消息 / 后端没启用 LangSmith)
    ///   - 非 nil → 显示反馈按钮
    let runId: String?

    /// Phase 10.1 #4 — 用户已经给过的反馈分数。
    ///
    /// 约定 0..1 浮点:1 = 👍,0 = 👎。
    /// nil 表示"还没反馈过"。
    ///
    /// MessageBubbleView 根据它决定按钮的可点状态:
    ///   - nil  → 两个按钮都可点
    ///   - 1.0  → 👍 高亮,两个按钮都禁用
    ///   - 0.0  → 👎 高亮,两个按钮都禁用
    ///
    /// 用 Double? 不用 Bool 是为了和后端 score 接口对齐,也给未来星级/LLM judge
    /// 共用同一个字段留扩展空间。
    let feedbackScore: Double?

    init(
        role: ChatMessageRole,
        content: String,
        structuredAnswer: StructuredAnswer? = nil,
        agentToolSteps: [AgentToolStep] = [],
        runId: String? = nil,
        feedbackScore: Double? = nil,
        id: UUID = UUID()
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.structuredAnswer = structuredAnswer
        self.agentToolSteps = agentToolSteps
        self.runId = runId
        self.feedbackScore = feedbackScore
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
            agentToolSteps: agentToolSteps,
            runId: runId,
            feedbackScore: feedbackScore,
            id: id
        )
    }

    /// 返回一条“工具步骤已更新，但消息正文和 id 保持不变”的消息。
    ///
    /// 这样工具状态变化时，SwiftUI 仍然认为这是同一条 AI 消息，
    /// 不会把工具状态渲染成新的聊天气泡。
    func updatingAgentToolSteps(_ newSteps: [AgentToolStep]) -> ChatMessage {
        ChatMessage(
            role: role,
            content: content,
            structuredAnswer: structuredAnswer,
            agentToolSteps: newSteps,
            runId: runId,
            feedbackScore: feedbackScore,
            id: id
        )
    }

    /// Phase 10.1 #4 — 流式结束、SSE done 事件到达时,把 runId 写到这条消息上。
    /// 其余字段保持不变,符合"updating* 系列保留 id + 不相关字段"的惯例。
    func updatingRunId(_ newRunId: String?) -> ChatMessage {
        ChatMessage(
            role: role,
            content: content,
            structuredAnswer: structuredAnswer,
            agentToolSteps: agentToolSteps,
            runId: newRunId,
            feedbackScore: feedbackScore,
            id: id
        )
    }

    /// Phase 10.1 #4 — 用户点击 👍/👎 / 反馈撤销时更新 feedbackScore。
    /// 传 nil 表示"撤销反馈"(目前 UI 还不支持撤销,但 API 留着)。
    func updatingFeedbackScore(_ newScore: Double?) -> ChatMessage {
        ChatMessage(
            role: role,
            content: content,
            structuredAnswer: structuredAnswer,
            agentToolSteps: agentToolSteps,
            runId: runId,
            feedbackScore: newScore,
            id: id
        )
    }

}
