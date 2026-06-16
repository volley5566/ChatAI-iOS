//
//  MemoryViewModel.swift
//  ChatAI-iOS
//
//  Phase 12 #5 — "AI 记忆"管理页的大脑。
//

import Combine
import Foundation

/// 管理"AI 记住了关于我的哪些事":加载列表、手动添加、删除、清空。
///
/// 和 ThreadListViewModel 同款写法:@MainActor + @Published + 注入 ChatAPI,
/// 删除走"乐观更新"(本地先删,失败再插回)。
@MainActor
final class MemoryViewModel: ObservableObject {
    @Published private(set) var memories: [MemoryItem] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let chatAPI: ChatAPI

    init(chatAPI: ChatAPI? = nil) {
        self.chatAPI = chatAPI ?? ChatAPIClient()
    }

    /// 拉取记忆列表。失败时保留已有数据,只显示错误(和 ThreadListViewModel 一致)。
    func load() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            memories = try await chatAPI.listMemories()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// 手动添加一条记忆。成功后插到列表最前面(后端按 updatedAt 倒序,新加的最新)。
    /// kind 默认 "semantic"。
    func add(content: String, kind: String = "semantic") async {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        errorMessage = nil
        do {
            let created = try await chatAPI.addMemory(content: trimmed, kind: kind)
            memories.insert(created, at: 0)
        } catch {
            errorMessage = "添加失败:\(error.localizedDescription)"
        }
    }

    /// 删除一条——乐观更新:本地立刻删,失败插回原位。
    func delete(id: String) async {
        guard let index = memories.firstIndex(where: { $0.id == id }) else { return }
        let removed = memories[index]
        memories.remove(at: index)

        do {
            try await chatAPI.deleteMemory(id: id)
        } catch {
            let safeIndex = min(index, memories.count)
            memories.insert(removed, at: safeIndex)
            errorMessage = "删除失败:\(error.localizedDescription)"
        }
    }

    /// 一键清空——乐观更新:本地先清空,失败把整批恢复回来。
    func clearAll() async {
        guard !memories.isEmpty else { return }
        let snapshot = memories
        memories = []

        do {
            try await chatAPI.clearMemories()
        } catch {
            memories = snapshot
            errorMessage = "清空失败:\(error.localizedDescription)"
        }
    }
}
