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
    /// 给我一个 StructuredAnswer，我把它展示出来。
    let answer: StructuredAnswer

    var body: some View {
        // 内部内容垂直排列，左对齐，每块之间间距 12。
        VStack(alignment: .leading, spacing: 12) {
            // 标题。
            Text(answer.title)
                // 使用 headline 字体。
                .font(.headline)
                // 使用主要文字颜色，foregroundStyle(.primary) 会自动适配深色模式和浅色模式。
                .foregroundStyle(.primary)

            // 摘要。
            Text(answer.summary)
                .font(.body)
                .foregroundStyle(.primary)

            // 重点列表。
            if !answer.points.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("重点")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)

                    // 用 offset 当 id，可以避免两个重点内容完全相同时
                    // SwiftUI 因为重复 id 产生列表刷新问题。
                    // let points: [String] 这是一个普通数组
                    // enumerated() 的作用是：遍历数组时，同时拿到下标和内容  (offset: 0, element: "用 View 描述界面结构")
                    // 为什么外面还要包一层 Array(...)？
                    // 因为 enumerated() 返回的不是一个真正的数组，而是一个类似“可遍历序列”的东西
                    // 但是 SwiftUI 的 ForEach 更喜欢接收明确的数组数据,所以这里用把它转换成真正的数组
                    // id: \.offset 是什么？
                    // 用 offset，也就是数组下标，作为每一行的唯一 id。
                    // _, point 是什么？
                    // 其实是在接收 enumerated() 产生的两个值：
                    // 完整写法应该是：ForEach(Array(answer.points.enumerated()), id: \.offset) { offset, point in
                    // offset = 当前下标
                    // point  = 当前内容
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

            // 下一步问题。
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
