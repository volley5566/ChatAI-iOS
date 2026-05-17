//
//  ThreadMessage.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/17.
//

import Foundation

/// Phase 5.5 — 从后端拉回的"已存档对话消息"。
///
/// ─────────────────────────────────────────────────────────────────────
/// 这个模型对应后端 `GET /api/threads/:id/messages` 返回的一项。
///
/// 后端 JSON 形如:
/// [
///   { "role": "user",      "content": "我叫 Nathan" },
///   { "role": "assistant", "content": "你好,Nathan!" },
///   { "role": "user",      "content": "我喜欢吃苹果" }
/// ]
/// ─────────────────────────────────────────────────────────────────────
///
/// # 它和 ChatMessage 有什么区别?
///
/// 这两个模型很容易混,职责一定要分清:
///
///   ChatMessage    — iOS 页面气泡用的"富模型"。
///                    带 UUID、structuredAnswer、agentToolSteps、流式输出 in-place 更新逻辑。
///
///   ThreadMessage  — 网络层 DTO,只承载后端给的 role+content。
///                    没 id(它就是后端 checkpointer state 里的一条历史快照)。
///
/// 5.5.5 里 ChatViewModel 切换对话时会做这一步转换:
///   ThreadMessage(role: "user", content: "...")
///     → ChatMessage(role: .user, content: "...", id: UUID())
///
/// # 为什么 role 用 String 而不是 ChatMessageRole 枚举?
///
/// 因为 ChatMessageRole 是给 UI 层用的(只有 .user / .assistant)。
/// 后端理论上未来可能扩展更多 role(system / tool 等),
/// 网络层先用 String 接住,转换成 ChatMessage 时再过滤掉不认识的。
/// 这是经典的"边界处用宽松类型,内部用严格枚举"做法。
///
/// # 为什么用 Decodable 而不是 Codable?
///
/// iOS 永远不会把 ThreadMessage 发回后端——
/// 写操作走 /api/agent/stream(直接发 message + thread_id),
/// ThreadMessage 只承担"读后端历史"这一个方向,所以 Encodable 不需要。
struct ThreadMessage: Decodable, Equatable {
    /// 这条消息是谁说的——"user" 或 "assistant"。
    ///
    /// 后端 threadsRepository.messagesToThreadMessages 已经过滤过:
    ///   - HumanMessage    → "user"
    ///   - 有 content 的 AIMessage → "assistant"
    /// 其它(tool_calls 中间消息、ToolMessage、SystemMessage)都不会出现在这里。
    ///
    /// 即便如此,iOS 端处理时仍然要兜底——别假设后端 100% 干净。
    let role: String

    /// 消息正文(纯文本)。
    let content: String
}
