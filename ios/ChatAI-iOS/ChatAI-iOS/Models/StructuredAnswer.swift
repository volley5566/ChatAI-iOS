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

    /// 把结构化回答整理成普通文本，作为下一轮对话的历史上下文。
    ///
    /// 为什么不直接把 JSON 发回后端？
    /// 因为 AI API 需要的是自然对话历史。
    /// 用标题、摘要、重点拼成文本，更接近“上一轮 AI 说过的话”。
    var historyContent: String {
        var parts = [
            title,
            summary
        ]

        if !points.isEmpty {
            let pointsText = points
                .map { "- \($0)" }
                .joined(separator: "\n")

            parts.append("重点：\n\(pointsText)")
        }

        /// UI 会把 nextQuestion 显示成“下一步”建议。
        ///
        /// 如果用户下一句回复“好，讲这个”“继续这个”，
        /// 模型需要从历史里看到上一轮 AI 提出的建议问题，
        /// 才能正确理解“这个”指的是什么。
        ///
        /// 所以这里不能只记录 title / summary / points，
        /// 也要把 nextQuestion 放进历史上下文。
        let trimmedNextQuestion = nextQuestion.trimmingCharacters(in: .whitespacesAndNewlines)

        if !trimmedNextQuestion.isEmpty {
            parts.append("下一步建议：\n\(trimmedNextQuestion)")
        }

        return parts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }
}
