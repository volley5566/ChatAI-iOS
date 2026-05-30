//
//  Checkpoint.swift
//  ChatAI-iOS
//
//  Phase 9 #7-#8 — Time-travel(时光机)模型。
//

import Foundation

/// 一个 thread 的某个"可分叉时刻"摘要。
///
/// 后端 LangGraph checkpointer 把每一步对话都存了快照,
/// `GET /api/threads/:id/checkpoints` 把这些快照里"用户可以分叉的点"
/// (即 AI 说完一句完整回答、没有 pending 工具调用的时刻)整理出来给我们。
///
/// 字段含义对应后端 langchain/agentGraph.ts:CheckpointSummary
/// (走 snake_case → camelCase 自动转换)。
struct Checkpoint: Identifiable, Equatable, Decodable {
    /// 后端 LangGraph 给每个 checkpoint 分配的不透明 id,fork 时原样回传。
    let checkpointID: String

    /// 创建时间(后端 SQLite 写入的 ISO 8601 字符串,iOS 端目前只是展示用)。
    let createdAt: String

    /// 在 thread 时间线上的位置(0 表示最早,1 其次...)。
    /// 我们用它和 iOS 端"第 N 条 AI 消息"对齐,实现长按 AI 气泡找到对应 checkpoint。
    let step: Int

    /// 这一刻 state 里有几条消息(过滤前的原始数,含 ToolMessage 等内部消息)。
    let messageCount: Int

    /// AI 在这一刻说的话(最多 80 字符,后端已经截断)—— 调试时打印用。
    let preview: String

    /// SwiftUI Identifiable —— 用 checkpointID 当 id 就行(后端保证唯一)。
    var id: String { checkpointID }

    enum CodingKeys: String, CodingKey {
        case checkpointID = "checkpoint_id"
        case createdAt = "created_at"
        case step
        case messageCount = "message_count"
        case preview
    }
}

/// `GET /api/threads/:id/checkpoints` 的响应体,只有一个 checkpoints 数组。
struct CheckpointsResponse: Decodable {
    let checkpoints: [Checkpoint]
}
