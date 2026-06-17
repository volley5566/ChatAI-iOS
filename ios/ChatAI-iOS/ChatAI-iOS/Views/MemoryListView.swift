//
//  MemoryListView.swift
//  ChatAI-iOS
//
//  Phase 12 #5 — "AI 记忆"管理页。
//

import SwiftUI

/// 让用户看见 AI 记住了关于自己的哪些事,并能手动添加 / 删除 / 一键清空。
///
/// 透明 + 可控:这是跨对话记忆功能的"信任面板"。用户能随时知道 AI 记了啥、
/// 撤回不想被记住的内容(对隐私友好)。
///
/// 以 .sheet 形式从对话列表页弹出,自带一个 NavigationStack,完全自包含。
struct MemoryListView: View {
    @StateObject private var viewModel = MemoryViewModel()
    @Environment(\.dismiss) private var dismiss

    /// 记忆类型的固定展示顺序(事实 → 经历 → 偏好),用于分段。
    private let kindOrder = ["semantic", "episodic", "procedural"]

    // 添加面板状态
    @State private var showingAddSheet = false
    // 清空确认
    @State private var showingClearConfirm = false

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.memories.isEmpty && viewModel.isLoading {
                    loadingView
                } else if viewModel.memories.isEmpty {
                    emptyStateView
                } else {
                    memoryList
                }
            }
            .overlay(alignment: .top) {
                if let errorMessage = viewModel.errorMessage {
                    errorBanner(errorMessage)
                }
            }
            .navigationTitle("AI 记忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // 关闭 sheet
                ToolbarItem(placement: .topBarLeading) {
                    Button("完成") { dismiss() }
                }
                // 添加 + 清空
                ToolbarItem(placement: .topBarTrailing) {
                    HStack {
                        Button {
                            showingAddSheet = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("添加记忆")

                        Button(role: .destructive) {
                            showingClearConfirm = true
                        } label: {
                            Image(systemName: "trash")
                        }
                        .accessibilityLabel("清空全部记忆")
                        .disabled(viewModel.memories.isEmpty)
                    }
                }
            }
            .sheet(isPresented: $showingAddSheet) {
                AddMemorySheet { content, kind in
                    Task { await viewModel.add(content: content, kind: kind) }
                }
            }
            .confirmationDialog(
                "清空全部记忆?",
                isPresented: $showingClearConfirm,
                titleVisibility: .visible
            ) {
                Button("清空全部", role: .destructive) {
                    Task { await viewModel.clearAll() }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("AI 将忘记关于你的所有长期记忆,此操作不可撤销。")
            }
            .task {
                await viewModel.load()
            }
        }
    }

    // ─── 状态:加载中 / 空 ────────────────────────────────────────

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("加载记忆中...")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "brain.head.profile")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)

            Text("还没有记忆")
                .font(.title3.weight(.medium))

            Text("聊天中 AI 会自动记住关于你的关键信息,\n你也可以点右上角 + 手动添加。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // ─── 状态:列表(按类型分段)──────────────────────────────────

    private var memoryList: some View {
        List {
            ForEach(kindOrder, id: \.self) { kind in
                let items = viewModel.memories.filter { $0.kind == kind }
                if !items.isEmpty {
                    Section(sectionTitle(for: kind)) {
                        ForEach(items) { memory in
                            Text(memory.content)
                                .font(.body)
                                .padding(.vertical, 2)
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        Task { await viewModel.delete(id: memory.id) }
                                    } label: {
                                        Label("删除", systemImage: "trash")
                                    }
                                }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await viewModel.load()
        }
    }

    /// 段标题:用中文标签 + 该类数量。
    private func sectionTitle(for kind: String) -> String {
        let label: String
        switch kind {
        case "semantic": label = "事实"
        case "episodic": label = "经历"
        case "procedural": label = "偏好"
        default: label = "记忆"
        }
        return label
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(message)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                viewModel.errorMessage = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.12))
    }
}

/// 手动添加记忆的小面板:文本框 + 类型选择 + 保存。
private struct AddMemorySheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var content = ""
    @State private var kind = "semantic"

    /// 保存回调:把 (content, kind) 交回给上层 VM。
    let onSave: (String, String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("记住什么") {
                    TextField("例如:我在学 SwiftUI,喜欢看代码示例", text: $content, axis: .vertical)
                        .lineLimit(3...6)
                }
                Section("类型") {
                    Picker("类型", selection: $kind) {
                        Text("事实").tag("semantic")
                        Text("经历").tag("episodic")
                        Text("偏好").tag("procedural")
                    }
                    .pickerStyle(.segmented)
                }
            }
            .navigationTitle("添加记忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") {
                        onSave(content, kind)
                        dismiss()
                    }
                    .disabled(content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

#if DEBUG
#Preview {
    MemoryListView()
}
#endif
