//
//  ThreadListView.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/18.
//

import SwiftUI

/// Phase 5.6 — 对话列表页。
///
/// ─────────────────────────────────────────────────────────────────────
/// 这个页面**只关心列表本身**:
///   - 加载状态(整屏 spinner / 空状态 / 列表 / 错误 banner)
///   - 每行展示 + 左滑删除
///   - 用 NavigationLink(value:) 把"点击哪一行"告诉外层 NavigationStack
///
/// **不**关心:
///   - 怎么跳到 ChatView——那是外层 NavigationStack + .navigationDestination 的事
///   - 怎么"新建对话"——那是 toolbar 按钮的事,5.6.5 加
///
/// 解耦的好处:这个 View 可以独立 Preview,也可以放进其他 NavigationStack(
/// 比如未来做 iPad 分栏布局时直接复用)。
/// ─────────────────────────────────────────────────────────────────────
struct ThreadListView: View {
    /// @StateObject:这个页面创建并持有 ThreadListViewModel,
    /// 页面 body 反复刷新也不会重复 new。和 ChatViewModel 的用法一致。
    @StateObject private var viewModel = ThreadListViewModel()

    var body: some View {
        // 这里的 4 种状态对应的子视图,在下面的 @ViewBuilder 函数里分别返回。
        // body 只负责"选择哪个分支",细节藏在子函数里——保持顶层视觉简洁。
        Group {
            if viewModel.threads.isEmpty && viewModel.isLoading {
                // 状态 1:首次加载中
                loadingView
            } else if viewModel.threads.isEmpty {
                // 状态 2:加载完了但确实没数据
                emptyStateView
            } else {
                // 状态 3:正常列表
                threadList
            }
        }
        // errorMessage 有值时叠加红色 banner 在顶部。
        // overlay 比把 banner 塞进 VStack 更好——它不挤占列表空间,
        // 错误消失时也不会引起列表布局抖动。
        .overlay(alignment: .top) {
            if let errorMessage = viewModel.errorMessage {
                errorBanner(errorMessage)
            }
        }
        .navigationTitle("对话")
        // toolbar 右上角:"+"(其实是 iOS 标准的"新建消息"图标 square.and.pencil)。
        //
        // 用 NavigationLink(value:) 而不是 Button { ... }:
        //   - 直接推 NewConversation 值到 NavigationStack 的 path
        //   - 由外层 ContentView 的 .navigationDestination(for: NewConversation.self) 接住
        //   - 不需要在这里 import / 引用 ChatView,View 之间彻底解耦
        //
        // 这就是"基于值的导航"的好处——列表页不知道也不需要知道目标 View 是什么。
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: NewConversation()) {
                    Image(systemName: "square.and.pencil")
                }
                // accessibility label——VoiceOver 用户听到的描述。
                // iOS 系统消息 App 的同款图标用的也是这个文案。
                .accessibilityLabel("新建对话")
            }
        }
        // .task vs .onAppear:
        //   .task 自带 async 上下文 + 视图消失时自动取消,
        //   是 iOS 15+ 加载数据的标准做法,优于 .onAppear { Task { ... } }。
        //
        // 关键:.task 默认 id 是 nil,所以"返回这个页面"会再次触发——
        // 这正好满足"从对话页返回时刷新列表"的需求(updatedAt 排序更新)。
        .task {
            await viewModel.loadThreads()
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 状态 1:首次加载中
    // ─────────────────────────────────────────────────────────────────────

    /// 整屏 spinner + 文字提示。
    /// 居中显示,避免出现在屏幕角落看起来像 bug。
    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("加载对话列表中...")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 状态 2:空状态
    // ─────────────────────────────────────────────────────────────────────

    /// 没有任何对话时显示的"引导卡片"。
    ///
    /// iOS 17+ 有原生 ContentUnavailableView,但为了兼容 iOS 16 这里自己拼。
    /// 文字引导用户点右上角 "+" 新建——具体加号按钮在 5.6.5 由 toolbar 提供。
    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)

            Text("还没有对话")
                .font(.title3.weight(.medium))

            Text("点击右上角 + 开始第一段对话")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // ─────────────────────────────────────────────────────────────────────
    // 状态 3:正常列表
    // ─────────────────────────────────────────────────────────────────────

    /// 列表本体。
    ///
    /// 用 List 而不是 ScrollView+LazyVStack:
    ///   - List 自带 swipeActions 修饰器,左滑删除一行 SwiftUI 代码
    ///   - List 自带分隔线、点击高亮、accessibility,比手撸 LazyVStack 省心
    ///   - 这种"目录页"场景就是 List 的主场,聊天页那种 bubble 才需要自定义滚动
    private var threadList: some View {
        List {
            ForEach(viewModel.threads) { thread in
                // NavigationLink(value:):把 value 推到外层 NavigationStack 的 path。
                // 外层 .navigationDestination(for: ThreadSummary.self) 接住后决定显示什么。
                //
                // 这种"value-based navigation"是 iOS 16 起的推荐写法,
                // 比老的 NavigationLink(destination:) 解耦更彻底——
                // 列表行不需要在编译期就知道目标 View 长啥样。
                NavigationLink(value: thread) {
                    threadRow(thread)
                }
            }
            // 左滑删除——直接绑定到 ForEach 的 onDelete 也能用,
            // 但 swipeActions 更灵活(可以放多个按钮、自定义颜色、阻止全滑触发等)。
            // 这里只放一个红色"删除"按钮,符合 iOS 标准交互。
            .onDelete { indexSet in
                deleteThreads(at: indexSet)
            }
        }
        // .listStyle 用 .insetGrouped 是 iOS 标准的"信息列表"风格,
        // 行有圆角、和屏幕边缘留间距,比 .plain 看着更精致。
        .listStyle(.insetGrouped)
        // 下拉刷新——SwiftUI 原生提供。
        // refreshable 会阻塞到 await 完成才放手,UI 上能看到下拉转圈。
        .refreshable {
            await viewModel.loadThreads()
        }
    }

    /// 单行视图。
    ///
    /// 显示:
    ///   - 标题(title 为空时退回到"新对话")
    ///   - 副标题灰字显示相对时间("今天" / "昨天" / "3 天前")
    private func threadRow(_ thread: ThreadSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(thread.title?.isEmpty == false ? thread.title! : "新对话")
                .font(.body)
                .lineLimit(1)

            Text(Self.relativeTimeFormatter.localizedString(for: thread.updatedAt, relativeTo: Date()))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 工具:错误 banner / 删除回调 / formatter
    // ─────────────────────────────────────────────────────────────────────

    /// 顶部错误 banner。
    /// 和 ContentView 的 errorBanner 风格保持一致,以后两个 banner 可以抽成共用组件,
    /// 这里 5.6 不重复造轮子,先各自复制一份。
    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)

            Text(message)
                .font(.footnote)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)

            // 给个关闭按钮——错误 banner 一直贴在顶部挡视线很烦。
            // 直接清空 errorMessage 就消失了。
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

    /// 处理 List.onDelete 给的 IndexSet——可能包含多个 index(虽然 iOS 默认只会一个)。
    ///
    /// 异步删除:每个 id 起一个 Task。
    /// 为啥不串行 await:删多个的概率极低(SwiftUI 默认单滑单删),
    /// 并发开销可忽略;真要批量删,后端也只是几个独立 DELETE,后端串行处理无所谓。
    private func deleteThreads(at offsets: IndexSet) {
        let idsToDelete = offsets.map { viewModel.threads[$0].id }
        for id in idsToDelete {
            Task {
                await viewModel.deleteThread(id: id)
            }
        }
    }

    /// 相对时间格式化器——静态单例,创建有成本。
    ///
    /// RelativeDateTimeFormatter 会输出"今天" / "昨天" / "3 天前" / "上个月"
    /// 这种自然语言,完美适配对话列表场景。
    /// 它会自动跟随系统语言(中文系统输出中文,英文系统输出英文),
    /// 不需要手写 if/else 处理本地化。
    private static let relativeTimeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full // "3 天前" 而不是 "3d ago"
        return formatter
    }()
}

#if DEBUG
#Preview {
    NavigationStack {
        ThreadListView()
    }
}
#endif
