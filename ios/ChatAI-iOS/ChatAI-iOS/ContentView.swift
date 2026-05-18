//
//  ContentView.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import SwiftUI

/// Phase 5.6 — App 根视图。
///
/// ─────────────────────────────────────────────────────────────────────
/// 5.5 之前,ContentView 既是入口又是聊天 UI——单页 App 很正常。
/// 5.6 引入对话列表后,ContentView 退化成"纯导航容器":
///
///   - 根视图:ThreadListView(对话列表)
///   - .navigationDestination(for: ThreadSummary.self):
///       列表里点击某行,推一个 ChatView 显示那段对话
///
/// 聊天 UI 本身搬到了 Views/ChatView.swift。
///
/// "+ 新建对话" 按钮(5.6.5 加)会通过另一个 navigationDestination 推一个
/// 新对话用的 ChatView(threadID: nil)。
/// ─────────────────────────────────────────────────────────────────────
struct ContentView: View {
    var body: some View {
        // NavigationStack 是 iOS 16+ 的现代导航容器,
        // 配合 .navigationDestination(for:) 实现"基于值的导航"——
        // 列表行不需要在编译期就知道目标 View 长啥样,只要 NavigationLink(value:) 推一个值,
        // navigationDestination 集中处理"值 → View"的映射。
        //
        // 这种模式的好处:
        //   - 导航逻辑集中在一处,而不是散落在每个列表行
        //   - 可以用 NavigationPath(@State 持有)做编程式导航 / deep link
        NavigationStack {
            ThreadListView()
                // 列表点击 → 推 ChatView 显示那段对话。
                // ThreadSummary 已经在 Models/ThreadSummary.swift 标了 Hashable,
                // 满足 NavigationLink(value:) 的类型要求。
                .navigationDestination(for: ThreadSummary.self) { thread in
                    ChatView(threadID: thread.id)
                }
                // toolbar "+" 按钮 → 推一个空的 ChatView 开始新对话。
                //
                // 为什么用 sentinel 类型(NewConversation)而不是 String/Optional?
                //   - navigationDestination 按 Swift 类型分发,String 已经被其他模式占用,
                //     Optional<String> 又不能直接 Hashable
                //   - 专门定义一个零字段 struct,语义清晰("我要推一个新对话页"),
                //     未来扩展(比如带初始 prompt)也只用扩这个 struct
                .navigationDestination(for: NewConversation.self) { _ in
                    ChatView(threadID: nil)
                }
        }
    }
}

/// 用于"新建对话"导航的 sentinel 类型。
///
/// 它本身不携带任何数据,作用只是给 NavigationLink(value:) 一个"独特类型"
/// 来匹配上面那条 .navigationDestination(for: NewConversation.self)。
///
/// Hashable 是 NavigationLink(value:) 的硬性要求(StackPath 内部用 hash 去重)。
/// 零字段 struct 的 Hashable 由 Swift 自动合成,所有实例 hash 都一样,
/// 这正是我们想要的——"新对话"这个意图不需要区分实例。
struct NewConversation: Hashable {}

#if DEBUG
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
#endif
