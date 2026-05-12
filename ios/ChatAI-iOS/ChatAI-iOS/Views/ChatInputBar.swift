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
    @Binding var inputText: String

    let isSending: Bool
    let canSend: Bool
    let onSend: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("输入消息...", text: $inputText, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .disabled(isSending)
                .submitLabel(.send)
                .onSubmit {
                    if canSend {
                        onSend()
                    }
                }

            Button(action: onSend) {
                Group {
                    if isSending {
                        ProgressView()
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 17, weight: .semibold))
                    }
                }
                .frame(width: 42, height: 42)
            }
            .buttonStyle(.borderedProminent)
            .clipShape(Circle())
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
