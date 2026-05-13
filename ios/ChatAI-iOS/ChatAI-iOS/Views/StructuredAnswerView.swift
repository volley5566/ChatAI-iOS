//
//  StructuredAnswerView.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/13.
//

import SwiftUI

/// AI 结构化回答的展示组件。
///
/// 它专门负责把 StructuredAnswer 的字段展示出来：
/// title        -> 标题
/// summary      -> 摘要
/// points       -> 重点列表
/// nextQuestion -> 下一步问题
///
/// 这样 MessageBubbleView 不需要知道具体怎么排版结构化内容，
/// 职责会更清楚。
struct StructuredAnswerView: View {
    let answer: StructuredAnswer

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(answer.title)
                .font(.headline)
                .foregroundStyle(.primary)

            Text(answer.summary)
                .font(.body)
                .foregroundStyle(.primary)

            if !answer.points.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("重点")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)

                    /// 用 offset 当 id，可以避免两个重点内容完全相同时
                    /// SwiftUI 因为重复 id 产生列表刷新问题。
                    ForEach(Array(answer.points.enumerated()), id: \.offset) { _, point in
                        HStack(alignment: .top, spacing: 8) {
                            Text("•")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.secondary)

                            Text(point)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }

            if !answer.nextQuestion.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("下一步")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)

                    Text(answer.nextQuestion)
                        .font(.callout)
                        .foregroundStyle(.primary)
                }
            }
        }
    }
}

#if DEBUG
struct StructuredAnswerView_Previews: PreviewProvider {
    static var previews: some View {
        StructuredAnswerView(
            answer: StructuredAnswer(
                title: "SwiftUI 是什么",
                summary: "SwiftUI 是 Apple 提供的声明式 UI 框架，适合用更简洁的方式构建界面。",
                points: [
                    "用 View 描述界面结构",
                    "用状态驱动界面刷新",
                    "适合快速构建 iOS 页面"
                ],
                nextQuestion: "你想继续了解 @State 是怎么工作的吗？"
            )
        )
        .padding()
    }
}
#endif
