//
//  ChatView.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/18.
//

import SwiftUI

/// Phase 5.6 — 单段对话页面。
///
/// ─────────────────────────────────────────────────────────────────────
/// 这是从 5.5 的 ContentView 抽出来的"聊天主体"。
///
/// 之前 ContentView 既是 App 入口,又是聊天 UI——单页 App 这么写没问题。
/// 5.6 引入了对话列表,需要"列表 → 推一个对话页"的导航结构,
/// ContentView 退化成纯 NavigationStack 容器,聊天 UI 搬到这里。
///
/// 调用方式:
///   - 从对话列表点击某行 → ContentView 的 .navigationDestination 接住 ThreadSummary
///     → 创建 ChatView(threadID: thread.id)
///   - 新建对话(5.6.5):toolbar "+" 把一个 sentinel 值推到 path
///     → 创建 ChatView(threadID: nil)
///
/// threadID 的语义:
///   - nil  → 新对话,ChatViewModel init 时放欢迎语,等用户发第一条消息时 createThread
///   - 非 nil → 已有对话,.task 里调 loadThread() 拉历史填回 messages
/// ─────────────────────────────────────────────────────────────────────
struct ChatView: View {
    /// 来自外层(NavigationStack)的对话 id。
    ///
    /// 用 let 不用 @State——这个值在 View 生命周期内不变。
    /// 用户想切对话?返回列表再 push 一个新的 ChatView 实例,
    /// 不是在同一个 ChatView 里改 threadID。
    let threadID: String?

    /// @StateObject 持有 ChatViewModel。
    ///
    /// 这里 init 里手动构造,把 threadID 传给 VM(决定是否放欢迎语)。
    /// _viewModel = StateObject(wrappedValue:) 是给 @StateObject 注入初值的官方写法。
    @StateObject private var viewModel: ChatViewModel

    init(threadID: String?) {
        self.threadID = threadID
        // wrappedValue 闭包只在 View 第一次 init 时执行——
        // 后续因为父 View 状态变化重新调用 ChatView(...) 时,
        // SwiftUI 会保留上一次的 ChatViewModel 实例,不会重复 new。
        // 这就是 @StateObject 和 @ObservedObject 的核心区别。
        _viewModel = StateObject(wrappedValue: ChatViewModel(threadID: threadID))
    }

    var body: some View {
        VStack(spacing: 0) {
            // 加载历史中(已有对话刚 push 进来还没拉到历史)→ 整屏 spinner
            // 否则 → 正常消息列表
            if viewModel.isLoadingHistory && viewModel.messages.isEmpty {
                historyLoadingView
            } else {
                messageList
            }

            if let errorMessage = viewModel.errorMessage {
                errorBanner(errorMessage)
            }

            ChatInputBar(
                inputText: $viewModel.inputText,
                // 加载历史期间禁用输入,防止用户在历史没填回来之前就发消息——
                // 那样会出现"消息列表上面是欢迎语,下面是用户新消息,中间历史空白"的错乱。
                isSending: viewModel.isSending || viewModel.isLoadingHistory,
                canSend: viewModel.canSendMessage && !viewModel.isLoadingHistory,
                onSend: sendMessage
            )
        }
        .navigationTitle("对话")
        // inline 显示模式——大标题(.large)占空间,聊天页要尽量给 messageList 留地方。
        .navigationBarTitleDisplayMode(.inline)
        // .task 在 View 出现时启动,View 消失时自动取消(避免后台还在拉历史浪费流量)。
        // 比 .onAppear { Task { ... } } 更现代、更安全。
        .task {
            // 只有"已有对话"才需要拉历史。
            // 新对话(threadID == nil)init 时已经放好欢迎语,啥也不做。
            if let threadID {
                await viewModel.loadThread(threadID: threadID)
            }
        }
        // Phase 9 #3 — HITL 审批卡片。
        //
        // sheet(item:) 监听 pendingApproval:
        //   - 非 nil → 自动弹卡片
        //   - 用户点[批准]/[拒绝] → dismiss → VM.approvePending/rejectPending
        //   - resolvePending 内部把 pendingApproval 清回 nil → sheet 自动关闭
        //
        // 用 `item:` 不用 `isPresented:` 是因为我们需要把 pending 数据传进去,
        // 而 isPresented 只能传布尔。
        .sheet(item: $viewModel.pendingApproval) { pending in
            ToolApprovalCard(
                pending: pending,
                onApprove: {
                    Task { await viewModel.approvePending() }
                },
                onReject: {
                    Task { await viewModel.rejectPending() }
                }
            )
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 子视图
    // ─────────────────────────────────────────────────────────────────────

    /// 加载历史时显示的整屏 loading。
    private var historyLoadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("加载历史消息...")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        // maxWidth/Height = .infinity 让 VStack 占满父容器,
        // 这样 ProgressView 才能在屏幕中央显示(VStack 本身居中其子视图)。
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// 聊天消息列表——逻辑和 5.5 ContentView 完全一致,只是搬过来了。
    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.messages) { message in
                        MessageBubbleView(
                            message: message,
                            // Phase 10.1 #4 — 把反馈点击转给 VM。
                            //
                            // 闭包里起 Task 是因为 submitFeedback 是 async,
                            // 而 SwiftUI 按钮回调是同步的。Task 默认继承
                            // @MainActor(VM 是 MainActor),所以不需要手动跳线程。
                            onSubmitFeedback: { score in
                                Task {
                                    await viewModel.submitFeedback(
                                        messageID: message.id,
                                        score: score
                                    )
                                }
                            }
                        )
                        .id(message.id)
                    }

                    if viewModel.isSending {
                        HStack {
                            ProgressView()
                            Text("AI 正在回复...")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal)
                    }
                }
                .padding()
            }
            .background(Color(.systemBackground))
            .onChange(of: viewModel.messages) { _, messages in
                scrollToBottom(messages: messages, proxy: proxy)
            }
        }
    }

    /// 顶部错误条。
    ///
    /// 点击关闭:errorMessage 默认只在下次发消息时才清空,
    /// 期间一直挂着会让 UI 看起来有"过期错误"。点一下就关。
    /// 关闭按钮单独放右边,文案区也可点(扩大热区,符合 iOS HIG)。
    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)

            Text(message)
                .font(.footnote)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)

            // 关闭按钮:点哪都行(整个 HStack 也加了 onTapGesture)
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.secondary)
                .imageScale(.medium)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.12))
        .contentShape(Rectangle())  // 让整个 banner 区域响应点击,不只是图标
        .onTapGesture {
            viewModel.errorMessage = nil
        }
        // 短动画让消失不那么突兀
        .transition(.opacity.combined(with: .move(edge: .top)))
        .animation(.easeOut(duration: 0.2), value: viewModel.errorMessage)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 动作
    // ─────────────────────────────────────────────────────────────────────

    /// 把"发送消息"包成同步函数,方便按钮和键盘 return 共用。
    /// 内部起一个 Task 跑异步 sendMessage。
    private func sendMessage() {
        Task {
            await viewModel.sendMessage()
        }
    }

    /// 自动滚动到最新一条消息。
    private func scrollToBottom(messages: [ChatMessage], proxy: ScrollViewProxy) {
        guard let lastMessage = messages.last else {
            return
        }

        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(lastMessage.id, anchor: .bottom)
        }
    }
}

#if DEBUG
#Preview("新对话") {
    NavigationStack {
        ChatView(threadID: nil)
    }
}
#endif
