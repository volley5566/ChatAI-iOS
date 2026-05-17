//
//  ThreadSummary.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/17.
//

import Foundation

/// Phase 5.5 — 对话元信息。
///
/// ─────────────────────────────────────────────────────────────────────
/// 这个模型对应后端 `GET /api/threads` 返回的一项,
/// 也对应 `POST /api/threads` 创建后返回的那一项。
///
/// 后端 JSON 形如:
/// {
///   "id": "uuid-...",
///   "title": "iOS 提问",
///   "created_at": "2026-05-17T08:00:00.000Z",
///   "updated_at": "2026-05-17T08:30:00.000Z"
/// }
/// ─────────────────────────────────────────────────────────────────────
///
/// # 为什么单独建一个模型,而不直接复用 ChatMessage?
///
/// ChatMessage 是"页面里那一条聊天气泡"的模型——带 UUID、structuredAnswer、agentToolSteps。
/// ThreadSummary 是"左侧对话列表的一行"——只有 id / 标题 / 时间。
/// 两个职责不同,不应该挤在一个 struct 里。
///
/// # 为什么用 Decodable 而不是 Codable?
///
/// - Decodable:后端 → iOS(JSON 解码)
/// - Codable = Decodable + Encodable
///
/// iOS 不会把 ThreadSummary 编码回 JSON 发给后端(后端只接收 thread_id 字符串),
/// 所以加 Encodable 是没必要的"未来主义"。
struct ThreadSummary: Identifiable, Decodable, Equatable {
    /// 对话 id。也是 SwiftUI ForEach 用来识别"这是哪一行"的稳定标识。
    ///
    /// 注意类型是 String,不是 UUID——
    /// 虽然后端用 uuid() 生成,但格式约定走通用字符串,
    /// 万一以后改成别的生成策略(短码、雪花 id)iOS 端不用改。
    let id: String

    /// 对话标题。
    ///
    /// 可为空——刚 POST /api/threads 没给 title 时,后端返回 null。
    /// UI 层显示时要 fallback 到"新对话"或第一句用户消息。
    let title: String?

    /// 对话创建时间。
    ///
    /// 后端用 ISO 8601 字符串(`"2026-05-17T08:00:00.000Z"`)。
    /// 这里直接保留 Date 类型,JSONDecoder 配合 .iso8601 dateDecodingStrategy 自动转。
    let createdAt: Date

    /// 对话最近活动时间。
    ///
    /// 后端在每次 /api/agent/stream 收到该 thread 的请求时会 touch 一下,
    /// 所以这个字段实质表示"对话列表里这条排在多前"。
    let updatedAt: Date

    /// 后端字段是 snake_case,Swift 这边用驼峰。
    /// CodingKeys 显式列出映射,比依赖 .convertFromSnakeCase 更稳——
    /// 万一以后某个字段 backend 用 snake、frontend 用别的非默认风格,这里改一行就行。
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}
