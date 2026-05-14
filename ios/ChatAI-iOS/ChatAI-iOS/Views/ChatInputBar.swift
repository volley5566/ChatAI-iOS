//
//  ChatInputBar.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import SwiftUI

/// 底部输入区域。
///
/// 这里用 @Binding 接收外部传进来的 inputText。
/// Binding 的意思是：
/// - 输入框改文字时，ViewModel.inputText 会同步变化
/// - ViewModel.inputText 改变时，输入框也会同步刷新
struct ChatInputBar: View {
    /// 这个 View 自己不拥有 inputText，
    /// 它只是绑定外部传进来的状态。
    ///
    /// 也就是说，真正的数据在 ContentView 的 viewModel.inputText 里。
    /// ChatInputBar 只是拿来用，并且可以修改它。
    ///
    /// ViewModel.inputText
    ///       ↑ ↓
    /// ChatInputBar.inputText
    ///       ↑ ↓
    /// TextField
    @Binding var inputText: String

    /// 是否正在发送。
    let isSending: Bool

    /// 当前能不能发送。
    let canSend: Bool

    /// 点击发送时执行的函数。
    let onSend: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            // 创建一个输入框。
            TextField("输入消息...", text: $inputText, axis: .vertical)
                // 输入内容绑定到 inputText，axis: .vertical 表示可以纵向扩展。
                .textFieldStyle(.plain)
                // 输入框最少 1 行，最多 5 行。
                .lineLimit(1...5)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                // 如果正在发送消息，就禁用输入框。
                .disabled(isSending)
                // 键盘右下角按钮显示成“send/发送”。
                .submitLabel(.send)
                // 用户按键盘发送时，如果 canSend 为 true，就调用 onSend()。
                .onSubmit {
                    if canSend {
                        onSend()
                    }
                }

            Button(action: onSend) {
                // 用 Group 包一下，让它们统一作为按钮内容。
                Group {
                    // 如果正在发送，按钮里面显示 loading。
                    if isSending {
                        ProgressView()
                    } else {
                        // 否则显示纸飞机图标。
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 17, weight: .semibold))
                    }
                }
                .frame(width: 42, height: 42)
            }
            .buttonStyle(.borderedProminent)
            .clipShape(Circle())
            // 如果不能发送，就禁用按钮。
            .disabled(!canSend)
            .accessibilityLabel("发送消息")
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

#if DEBUG
struct ChatInputBar_Previews: PreviewProvider {
    static var previews: some View {
        ChatInputBar(
            inputText: .constant("你好"),
            isSending: false,
            canSend: true,
            onSend: {}
        )
    }
}
#endif
