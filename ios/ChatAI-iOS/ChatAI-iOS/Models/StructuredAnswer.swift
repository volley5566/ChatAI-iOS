//
//  StructuredAnswer.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/13.
//

import Foundation

/// 后端返回给 iOS 的“结构化 AI 回答”。
///
/// 以前后端只返回：
/// {
///   "answer": "一整段文字"
/// }
///
/// 现在后端返回：
/// {
///   "title": "标题",
///   "summary": "摘要",
///   "points": ["重点 1", "重点 2"],
///   "next_question": "下一步可以问什么"
/// }
///
/// 这样 iOS 就不用从一大段文字里猜哪里是标题、哪里是重点，
/// 而是可以直接按字段展示不同区域。
struct StructuredAnswer: Decodable, Equatable {
    /// 回答标题。
    let title: String

    /// 简短摘要。
    let summary: String

    /// 重点列表。
    let points: [String]

    /// AI 推荐用户下一步可以追问的问题。
    let nextQuestion: String
}
