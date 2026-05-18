//
//  ThreadListViewModel.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/18.
//

import Combine
import Foundation

/// Phase 5.6 — 对话列表页的"大脑"。
///
/// ─────────────────────────────────────────────────────────────────────
/// 职责对照:
///   - ChatViewModel        管"一段对话内的消息列表 + 输入状态"
///   - ThreadListViewModel  管"所有对话的目录 + loading + 删除"
///
/// 两者完全独立——列表页里没有 ChatViewModel,对话页里没有 ThreadListViewModel。
/// 列表点击某行 → NavigationStack push 一个 ChatView,它自己 new 一个 ChatViewModel(threadID: id)。
/// 这样状态隔离干净,不需要在两个 VM 之间互传消息。
/// ─────────────────────────────────────────────────────────────────────
///
/// @MainActor:所有 @Published 属性更新都在主线程,SwiftUI 标准做法。
@MainActor
final class ThreadListViewModel: ObservableObject {
    /// 当前已加载的对话列表,按后端给的顺序(updatedAt 倒序)展示。
    /// @Published:数组变化 → SwiftUI List 自动 diff 刷新。
    @Published private(set) var threads: [ThreadSummary] = []

    /// 是否正在从后端拉列表。
    /// UI 在为 true 且 threads 为空时显示整屏 spinner;
    /// threads 非空时(下拉刷新场景)可以选择性显示 inline indicator。
    @Published private(set) var isLoading = false

    /// 当前错误提示。
    /// 有值时,UI 顶部显示红色 banner,和 ChatViewModel 风格一致。
    @Published var errorMessage: String?

    /// 网络层。和 ChatViewModel 一样通过 init 注入,便于测试时换 mock。
    private let chatAPI: ChatAPI

    init(chatAPI: ChatAPI? = nil) {
        // 同 ChatViewModel:不直接把 ChatAPIClient() 写默认参数里,
        // 避开 Swift 并发隔离下的默认参数警告。
        self.chatAPI = chatAPI ?? ChatAPIClient()
    }

    /// 从后端拉对话列表。
    ///
    /// 调用时机:
    ///   - ThreadListView 第一次出现(.task 或 .onAppear)
    ///   - 用户下拉刷新
    ///   - 从对话页返回列表时(为了让 updatedAt 排序刷新)
    ///
    /// 防并发:
    ///   如果已经在 loading 中,直接 return。
    ///   - 防止用户疯狂下拉触发多次请求
    ///   - 防止"返回列表 + 自动刷新"和"手动下拉"撞车
    ///   - 简单粗暴,不需要 Combine debounce 之类的复杂方案
    ///
    /// 错误处理:
    ///   失败时 errorMessage 显示原因,**threads 保持当前内容不动**——
    ///   不要清空到空数组,那样用户辛辛苦苦下拉刷新一下就丢失了已经能看到的列表,
    ///   体验比"加载失败但旧数据还在"差很多。
    func loadThreads() async {
        // 防并发的"门"。
        // 注意 @MainActor 保证这个读+写不会有 race condition——
        // 所有调用都在主线程串行执行,所以 if + isLoading=true 是原子的。
        guard !isLoading else { return }

        isLoading = true
        errorMessage = nil

        // defer 保证不管哪种退出路径(成功/失败/抛错),isLoading 都会归位。
        defer { isLoading = false }

        do {
            let loaded = try await chatAPI.listThreads()
            // 直接整体替换。后端返回的顺序就是"最近活跃倒序",iOS 不再二次排序。
            threads = loaded
        } catch {
            errorMessage = error.localizedDescription
            // 不清空 threads——保留已有数据,让用户能继续看到老列表。
        }
    }

    /// 删除某个对话——**乐观更新**实现。
    ///
    /// 流程:
    ///   1. 先在本地数组里把这一行删掉(UI 立刻消失)
    ///   2. 记下"删了什么 + 删的位置",以便失败时回滚
    ///   3. 调后端 DELETE /api/threads/:id
    ///   4. 成功:啥也不做(UI 已经是最终状态)
    ///   5. 失败:把这一行插回原位 + 显示 errorMessage
    ///
    /// 为什么用乐观?
    ///   - iOS 用户对"左滑删除立刻消失"有肌肉记忆,等几百毫秒会觉得卡
    ///   - DELETE 操作幂等(后端 deleteThread 不存在的 id 也返回 204),
    ///     即便客户端和服务端短暂不一致,下次拉列表也会自动对齐
    ///
    /// 为什么不只删本地不调后端?
    ///   - 那叫"逃避现实",下次 loadThreads 这行又会冒出来,用户以为有 bug
    ///
    /// 不返回 throws 的原因:
    ///   - 这是从 UI 直接触发的(swipeAction),错误统一通过 errorMessage 显示
    ///   - 调用方不需要 try / catch,UI 代码更干净
    func deleteThread(id: String) async {
        // 先在数组里定位要删的那一项。找不到说明状态已经不一致(可能是用户狂点),
        // 直接 return,不报错——这种情况下"什么都不做"是最稳的。
        guard let index = threads.firstIndex(where: { $0.id == id }) else {
            return
        }

        // 1. 记下被删的项 + 它原来的位置,留作回滚用。
        let removedThread = threads[index]

        // 2. 本地立刻删除(UI 立刻消失)。
        threads.remove(at: index)

        // 3. 异步调后端。
        do {
            try await chatAPI.deleteThread(threadID: id)
            // 4. 成功:啥都不用做,数组已经是最终状态。
        } catch {
            // 5. 失败:把项插回原位。
            //
            // 注意位置可能已经"无效"——如果在 await 期间用户又删了其他项,
            // 原来的 index 可能超过当前数组长度。所以用 min(index, count) 兜底,
            // 避免越界 crash。即便插入位置不完全准确,用户也能看到这一项"回来了",
            // 比直接消失要好。
            let safeIndex = min(index, threads.count)
            threads.insert(removedThread, at: safeIndex)

            errorMessage = "删除失败:\(error.localizedDescription)"
        }
    }
}
