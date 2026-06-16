//
//  MemoryItem.swift
//  ChatAI-iOS
//
//  Phase 12 #5 — 跨对话长期记忆的展示模型。
//

import Foundation

/// 一条"AI 记住的关于你的事"。
///
/// 对应后端 `GET /api/memories` 返回的一项 / `POST /api/memories` 创建后返回的那项:
/// {
///   "id": "uuid-...",
///   "kind": "semantic",
///   "content": "用户正在学习 SwiftUI",
///   "source_thread_id": null,
///   "created_at": "2026-06-16T...",
///   "updated_at": "2026-06-16T..."
/// }
///
/// 只 Decodable:iOS 不会把整个对象编码回后端(添加时只发 content/kind 两个字段)。
/// Identifiable 让 SwiftUI List 用 id 稳定识别每一行。
struct MemoryItem: Identifiable, Decodable, Equatable {
    let id: String
    /// "semantic" | "episodic" | "procedural"。用裸字符串和后端对齐,
    /// 展示用 kindLabel 翻成中文。
    let kind: String
    let content: String
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case kind
        case content
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    /// 给 UI 显示的中文类型标签(和后端 memoryKindLabel 一致)。
    var kindLabel: String {
        switch kind {
        case "semantic": return "事实"
        case "episodic": return "经历"
        case "procedural": return "偏好"
        default: return "记忆"
        }
    }
}

/// 后端 GET /api/memories 的 { "memories": [...] } 外层包装。
/// 和 ThreadListResponseBody 一样收在解码层,UI 只关心展开后的数组。
struct MemoryListResponseBody: Decodable {
    let memories: [MemoryItem]
}
