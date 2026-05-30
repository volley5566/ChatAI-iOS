//
//  ToolApprovalCard.swift
//  ChatAI-iOS
//
//  Phase 9 #3 — HITL 工具审批卡片
//

import SwiftUI

/// HITL 审批卡片。
///
/// 弹出时机:ChatViewModel.pendingApproval 非 nil 时 sheet 自动弹出。
/// 用户点[批准]/[拒绝] → 关闭 sheet → 触发 onApprove / onReject。
///
/// 当前版本不支持编辑参数(直接用原 args),后续可以加 TextField 改 args。
/// 编辑功能放后期是因为不同工具的参数 schema 不同(generateQuiz 是
/// {topic, count},recommendNextTopic 是 {recentTopics: [...]}),
/// 通用编辑 UI 复杂度不小,放第一版会拖累 HITL 主链路验证。
struct ToolApprovalCard: View {
    let pending: PendingApproval
    let onApprove: () -> Void
    let onReject: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // ─── 顶部:工具名 + 副标题 ─────────────────────
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Image(systemName: iconName(for: pending.toolName))
                                .font(.title2)
                                .foregroundStyle(.tint)
                            Text(pending.displayName)
                                .font(.title2.weight(.semibold))
                        }
                        Text("工具名: \(pending.toolName)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 4)

                    Divider()

                    // ─── 参数列表 ───────────────────────────────
                    VStack(alignment: .leading, spacing: 12) {
                        Text("参数")
                            .font(.headline)

                        if pending.args.isEmpty {
                            Text("(无参数)")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        } else {
                            // 按 key 字母排序,UI 稳定不抖动
                            ForEach(pending.args.sorted(by: { $0.key < $1.key }), id: \.key) { entry in
                                argRow(key: entry.key, value: entry.value)
                            }
                        }
                    }

                    Divider()

                    // ─── 说明文字 ───────────────────────────────
                    Text("AI 想调用上面的工具。点击[批准]让它执行,点击[拒绝]让 AI 改用其他方式回答。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Spacer(minLength: 80)
                }
                .padding()
            }
            .navigationTitle("审批工具调用")
            .navigationBarTitleDisplayMode(.inline)
            // 把按钮放在底部 toolbar,而不是滚动视图里 — 长 args 列表也能保证按钮可见。
            //
            // 重要:**不要在按钮回调里调 dismiss()**。
            // sheet 是绑定到 viewModel.pendingApproval 的,
            // 关闭 sheet 的方式是让 VM 把 pendingApproval 置 nil。
            // onApprove / onReject 内部会触发 VM,VM 在 resolvePending 第一行就清空 pendingApproval,
            // sheet 自动关闭。如果这里再调 dismiss(),会**抢在 Task 之前**把 binding 置 nil,
            // 导致 VM 里的 guard pendingApproval != nil 失败,resume 永远不发。
            .toolbar {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button(role: .destructive) {
                        onReject()
                    } label: {
                        Label("拒绝", systemImage: "xmark.circle")
                    }

                    Spacer()

                    Button {
                        onApprove()
                    } label: {
                        Label("批准", systemImage: "checkmark.circle.fill")
                            .font(.headline)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        // 不让用户下拉关闭 — 强制走批准/拒绝按钮,避免"sheet 关了但 thread 还在挂起"的死锁状态
        .interactiveDismissDisabled()
    }

    // ─────────────────────────────────────────────────────────────────────
    // 子视图
    // ─────────────────────────────────────────────────────────────────────

    /// 单条参数(key + value)的行视图。
    /// 值长的话支持多行显示,所以用 VStack 而不是 HStack。
    private func argRow(key: String, value: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(key)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value.displayString)
                .font(.callout)
                .textSelection(.enabled)  // 允许长按复制参数,排查问题方便
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    /// 工具名 → SF Symbol icon。
    /// 学习项目这种"枚举映射"内联在 View 里足够清晰,真正生产化可以抽到 ViewModel。
    private func iconName(for toolName: String) -> String {
        switch toolName {
        case "searchKnowledge":
            return "magnifyingglass.circle.fill"
        case "generateQuiz":
            return "questionmark.circle.fill"
        case "evaluateAnswer":
            return "checkmark.seal.fill"
        case "recommendNextTopic":
            return "lightbulb.fill"
        default:
            return "wrench.and.screwdriver.fill"
        }
    }
}

#if DEBUG
#Preview("generateQuiz") {
    Color.clear
        .sheet(isPresented: .constant(true)) {
            ToolApprovalCard(
                pending: PendingApproval(
                    toolCallID: "call_demo_123",
                    toolName: "generateQuiz",
                    displayName: "生成练习题",
                    args: [
                        "topic": .string("SwiftUI @State"),
                        "count": .number(3)
                    ]
                ),
                onApprove: { print("approve") },
                onReject: { print("reject") }
            )
        }
}
#endif
