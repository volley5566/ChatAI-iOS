//
//  ContentView.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import SwiftUI

struct ContentView: View {
    /// @StateObject 表示：
    /// 这个页面创建并持有 ChatViewModel。
    ///
    /// SwiftUI 页面会因为状态变化反复刷新 body，
    /// 但 @StateObject 可以保证 ViewModel 不会被重复创建。
    @StateObject private var viewModel = ChatViewModel()

    var body: some View {
        // 提供页面导航能力。
        NavigationStack {
            // 垂直排列。
            VStack(spacing: 0) {
                // 聊天列表。
                messageList

                // 错误提示，可有可无。
                // 如果 viewModel.errorMessage 有值，就取出来叫 errorMessage，
                // 然后显示错误条。
                if let errorMessage = viewModel.errorMessage {
                    errorBanner(errorMessage)
                }

                // 底部输入框。
                ChatInputBar(
                    // inputText：当前输入的文字。
                    // 重点：这里的 $ 表示双向绑定 Binding，会直接更新 viewModel.inputText。
                    inputText: $viewModel.inputText,
                    // isSending：是否正在发送。
                    isSending: viewModel.isSending,
                    // canSend：是否允许点击发送。
                    canSend: viewModel.canSendMessage,
                    // onSend：点击发送时执行什么逻辑。
                    onSend: sendMessage
                )
            }
            // 提供标题栏。
            .navigationTitle("AI Chat")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("清空") {
                        viewModel.resetConversation()
                    }
                    .disabled(viewModel.isSending)
                }
            }
        }
    }

    /// 聊天消息列表。
    ///
    /// ScrollViewReader 可以让我们拿到滚动控制器 proxy。
    /// 每次 messages 数组变化时，自动滚动到最后一条消息。
    private var messageList: some View {
        // ScrollViewReader：让我可以控制滚动位置。
        ScrollViewReader { proxy in
            // 可以上下滚动。
            ScrollView {
                // LazyVStack 懒加载垂直列表。
                LazyVStack(spacing: 12) {
                    // 遍历 messages 数组。
                    // viewModel.messages 是真正的数据源。
                    ForEach(viewModel.messages) { message in
                        // MessageBubbleView 每条消息显示成一个气泡。
                        MessageBubbleView(message: message)
                            .id(message.id)
                    }

                    // isSending 时显示“AI 正在回复...”。
                    if viewModel.isSending {
                        HStack {
                            // iOS 自带的 loading 圈。
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
            // 自动滚动到底部：
            // 用户发了一条消息
            //   ↓
            // messages 增加一条
            //   ↓
            // 触发 onChange
            //   ↓
            // 自动滚动到底部。
            .onChange(of: viewModel.messages) { _, messages in
                // 这个函数负责真正滚动。
                scrollToBottom(messages: messages, proxy: proxy)
            }
        }
    }

    /// 错误提示条。
    /// 比如后端没启动、网络断开、接口返回 500 时会显示。
    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)

            Text(message)
                .font(.footnote)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.12))
    }

    /// 把“发送消息”包成一个小函数，方便按钮和键盘 return 共用。
    private func sendMessage() {
        // 创建一个异步 Task。
        Task {
            // ViewModel 去处理真正的发送逻辑。
            await viewModel.sendMessage()
        }
    }

    /// 滚动到最后一条消息。
    private func scrollToBottom(
        messages: [ChatMessage],
        proxy: ScrollViewProxy
    ) {
        // 先拿到最后一条消息。如果没有消息，直接 return。
        //
        // guard 可以理解成 Swift 里的提前检查，不满足条件就直接退出。
        // 尝试从 messages 数组里取最后一条消息。
        //
        // 如果能取到：
        //     把它命名为 lastMessage，然后继续往下执行。
        //
        // 如果取不到：
        //     说明 messages 是空数组，直接 return，函数结束。
        //
        // Kotlin 类似：
        // val lastMessage = messages.lastOrNull() ?: return
        guard let lastMessage = messages.last else {
            return
        }

        // 如果有消息，就带动画滚动到最后一条。
        withAnimation(.easeOut(duration: 0.2)) {
            // ScrollViewReader：包住 ScrollView，让它变成“可被代码控制滚动”的 ScrollView。
            // ScrollViewProxy：ScrollView 的控制器，负责执行 scrollTo。
            // .id(...)：给要滚动到的目标 View 打标签。
            // proxy.scrollTo(...)：根据标签找到对应 View，然后滚过去。
            proxy.scrollTo(lastMessage.id, anchor: .bottom)
        }
    }
}

#if DEBUG
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
#endif
