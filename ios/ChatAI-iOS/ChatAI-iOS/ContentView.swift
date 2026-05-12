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
        NavigationStack {
            VStack(spacing: 0) {
                messageList

                if let errorMessage = viewModel.errorMessage {
                    errorBanner(errorMessage)
                }

                ChatInputBar(
                    inputText: $viewModel.inputText,
                    isSending: viewModel.isSending,
                    canSend: viewModel.canSendMessage,
                    onSend: sendMessage
                )
            }
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
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.messages) { message in
                        MessageBubbleView(message: message)
                            .id(message.id)
                    }

                    if viewModel.isSending {
                        HStack {
                            ProgressView()
                            Text("AI 正在思考...")
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
        Task {
            await viewModel.sendMessage()
        }
    }

    /// 滚动到最后一条消息。
    private func scrollToBottom(
        messages: [ChatMessage],
        proxy: ScrollViewProxy
    ) {
        guard let lastMessage = messages.last else {
            return
        }

        withAnimation(.easeOut(duration: 0.2)) {
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
