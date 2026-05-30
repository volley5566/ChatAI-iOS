//
//  ChatViewModel.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import Combine
import Foundation

/// ChatViewModel 是聊天页面的“大脑”。
///
/// ViewModel 不直接写 UI，也不直接关心按钮长什么样。
/// 它负责：
/// - 保存输入框内容
/// - 保存聊天消息列表
/// - 调用网络层发送消息
/// - 控制 loading / error 状态
///
/// @MainActor 表示这个类里的状态更新都在主线程执行。
/// SwiftUI 的页面状态应该在主线程更新，这样最安全。
/// 这个类里面的状态更新，都应该在主线程执行。
@MainActor
// final：这个类不能被继承。
// ObservableObject：这个对象可以被 SwiftUI 观察，View 可以观察这个 ViewModel。
final class ChatViewModel: ObservableObject {
    /// Phase 5.5.5 — 当前对话的 thread id。
    ///
    /// 生命周期:
    ///   - 初始为 nil(还没发任何消息)
    ///   - 用户点击发送第一条消息时,sendMessage() 会先调 createThread() 拿到 id 存进来
    ///   - 后续消息一律带这个 id 发,后端的 checkpointer 负责持久化
    ///   - resetConversation() 会把它清回 nil,等于"开始一段新对话"
    ///
    /// 为什么用 private var,不用 @Published?
    ///   5.5 阶段没有 UI 直接观察它(对话列表 UI 是 5.6 的事)。
    ///   暂时只供 ViewModel 自己用,保持 private 最简单。
    ///   5.6 引入对话列表时,如果需要顶部显示"当前对话 xxx",再升级成 @Published。
    private var currentThreadID: String?

    /// 聊天消息列表。页面会根据它自动刷新。
    /// @Published：这个变量一变化，就通知 SwiftUI 页面刷新。
    ///
    /// Phase 5.6:不再在属性初始化时就放欢迎语——因为这个 ViewModel
    /// 既可能给"新对话"用(此时该有欢迎语),也可能给"加载已有对话"用
    /// (此时不该有欢迎语,直接展示后端拉回来的历史)。
    /// 欢迎语放到 init 里**按场景**决定塞不塞。
    @Published var messages: [ChatMessage] = []

    /// 输入框当前文字。
    /// @Published：这个变量一变化，就通知 SwiftUI 页面刷新。
    @Published var inputText = ""

    /// 是否正在等待后端返回。
    /// 为 true 时，按钮会禁用，并显示发送中的状态。
    /// 表示当前是否正在发送请求 / 等待 AI 回复
    ///
    /// isSending = true
    ///     输入框禁用
    ///     发送按钮禁用
    ///     显示 loading
    ///     清空按钮禁用
    ///
    /// isSending = false
    ///     恢复正常输入和发送
    /// @Published：这个变量一变化，就通知 SwiftUI 页面刷新。
    @Published var isSending = false

    /// Phase 5.6 — 是否正在从后端拉历史消息。
    ///
    /// 和 isSending 分开,因为这是两种不同的"忙":
    ///   - isLoadingHistory:打开已有对话时,从 GET /api/threads/:id/messages 拉历史
    ///   - isSending:已经在对话里,POST /api/agent/stream 等 AI 回答
    /// UI 可以分别给出不同的 loading 视觉(整页 spinner vs 输入条 disabled)。
    @Published var isLoadingHistory = false

    /// 当前错误提示。
    /// 有值时，页面会显示一条红色提示。
    /// @Published：这个变量一变化，就通知 SwiftUI 页面刷新。
    @Published var errorMessage: String?

    /// Phase 9 #3 — HITL: 当前挂起的工具批准请求。
    ///
    /// 生命周期:
    ///   - 收到 .toolPending 或 .done(pending: 非 nil) → 设上
    ///   - 用户点[批准]/[拒绝] → resumeApproval(...) 把它清空,开始续跑
    ///   - 续跑流到 done(pending: 非 nil) → 再次设上(模型连环挂起的情况)
    ///
    /// ChatView 用 .sheet(item:) 监听这个值:非 nil 时弹卡片,nil 时关闭。
    /// Identifiable 让 sheet(item:) 能正确识别"新的 pending"——
    /// 同一 thread 连续挂起两次时,sheet 会被重新弹出。
    @Published var pendingApproval: PendingApproval?

    /// Phase 9 #3 — 挂起期间记住对应的 assistant 消息 id。
    ///
    /// resume 续跑后,新的 SSE delta 应该追加到**同一条**气泡上,
    /// 而不是新开一条。这个 id 在 sendMessage() 第一次挂起时记下,
    /// resumeApproval() 时复用,直到 done(pending: nil) 才清掉。
    private var suspendedMessageID: UUID?

    /// Phase 9 #3 — 挂起期间累积的部分回答文本。
    /// resume 后从这个值继续 += delta,避免 UI 上文本被截断。
    private var suspendedStreamedAnswer: String = ""

    /// Phase 9 #3 — 刚 resume 过的 tool_call_id,用来过滤"回声 tool_pending"。
    ///
    /// 为什么需要?
    /// LangGraph 的 interrupt() 语义是:resume 时**节点函数从头重跑**,
    /// interrupt 之前的代码(包括后端 onToolEvent 发出的 tool_pending SSE)
    /// 会再次执行,iOS 端会收到同一个 tool_call_id 的第二条 tool_pending。
    ///
    /// 如果不去重,sheet 会被重新弹出 → 用户再点批准 → /resume 又发一次 →
    /// 工具被执行两次。
    ///
    /// 解决:resolvePending 进入时记下当前的 tool_call_id,
    /// 在 resume 流里收到的 tool_pending 如果 id 相同,就直接忽略。
    /// resume 流结束(done with pending: nil)时清空,避免污染后续会话。
    private var justResumedToolCallID: String?

    // 这个是网络层接口：
    //
    // View
    //   ↓
    // ViewModel
    //   ↓
    // ChatAPI 协议
    //   ↓
    // ChatAPIClient 实现
    //   ↓
    // Node.js 后端 / AI 接口
    private let chatAPI: ChatAPI

    /// Phase 5.6 — 初始化。
    ///
    /// 两个场景:
    ///   - 新对话:`ChatViewModel()` → threadID = nil → 放欢迎语,等用户发第一条消息时 createThread
    ///   - 加载已有对话:`ChatViewModel(threadID: "xxx")` → 不放欢迎语,等 View 在 .task 里调 loadThread() 填回历史
    ///
    /// 关键设计:**init 里收到 threadID 也不直接写 currentThreadID**——
    /// 那个字段只在 loadThread() 加载成功后才被设上。理由:
    ///   如果 loadThread 网络失败、但 currentThreadID 已被设,sendMessage 会
    ///   把新消息追加到一个"我们并不知道历史长啥样的 thread"上,后端 checkpointer
    ///   会接上,但 iOS 端用户看不到前情,体验是错乱的。
    /// 让 currentThreadID 的写入和"历史成功加载"绑在一起,保证 invariant。
    ///
    /// 如果外部传了 chatAPI，就用外部传进来的。
    /// 如果外部没传，就默认用 ChatAPIClient()。
    init(threadID: String? = nil, chatAPI: ChatAPI? = nil) {
        // 这里不直接把 ChatAPIClient() 写在参数默认值里，
        // 是为了避开 Swift 并发隔离下的一个默认参数警告。
        // 简单理解：默认参数会在 init 外面先计算；
        // 写在 init 里面更符合这个 ViewModel 的主线程上下文。
        self.chatAPI = chatAPI ?? ChatAPIClient()

        if threadID == nil {
            // 新对话场景:放一条欢迎语作为开场白。
            messages = [
                ChatMessage(
                    role: .assistant,
                    content: "你好，我是你的 AI 助手。你可以问我 SwiftUI、iOS 或 AI 应用开发相关的问题。"
                )
            ]
        }
        // 有 threadID 时 messages 保持空,等 ChatView 在 .task 里调
        // loadThread() 填回历史。期间 isLoadingHistory = true,UI 显示 loading
        // 而不是闪一下欢迎语再被替换掉。
    }

    /// 发送按钮是否可以点击。
    ///
    /// 规则：
    /// - 输入框不能为空
    /// - 当前没有正在发送的请求
    ///
    /// 这个是计算属性
    /// 它不是保存一个值，而是每次访问时动态计算
    var canSendMessage: Bool {
        !trimmedInputText.isEmpty && !isSending
    }

    /// 点击发送按钮后调用。
    ///
    /// 当前默认走“Agent 流式输出”：
    /// - 用户消息立即追加到列表
    /// - 再追加一条空的 assistant 消息
    /// - 后端先完成 Tool Calling 阶段
    /// - 后端再把最终回答通过 SSE 返回
    /// - 每收到一个 delta，就更新这条 assistant 消息的 content
    ///
    /// 普通流式接口和结构化接口仍然保留在 ChatAPIClient 里，
    /// 方便后续做对比测试或“最终结构化卡片”升级。
    /// 它是异步函数，因为里面要请求后端、处理流式返回
    ///
    /// 用户点击发送
    ///    ↓
    /// sendMessage()
    ///    ↓
    /// 取出输入框文字并 trim
    ///    ↓
    /// 如果为空，直接 return
    ///    ↓
    /// 整理历史消息 history
    ///    ↓
    /// 把用户消息 append 到 messages
    ///    ↓
    /// 清空输入框
    ///    ↓
    /// errorMessage = nil
    ///    ↓
    /// isSending = true
    ///    ↓
    /// 创建流式请求 stream
    ///    ↓
    /// 先 append 一条空的 assistant 消息
    ///    ↓
    /// 不断接收后端 SSE update
    ///    ↓
    /// 收到 delta：更新 assistant content
    ///    ↓
    /// 收到 toolStart：更新工具步骤 running
    ///    ↓
    /// 收到 toolDone：更新工具步骤 completed / failed
    ///    ↓
    /// 结束后如果没内容，抛 emptyAnswer
    ///    ↓
    /// 如果出错，显示 errorMessage
    ///    ↓
    /// defer 自动 isSending = false
    func sendMessage() async {
        // 第一步：取出输入内容。
        let messageText = trimmedInputText

        // 如果输入为空，就直接退出，不发送。
        //guard 是 Swift 的"提前 return"语法。条件不成立直接退出,类似 Kotlin 的 ?: return
        guard !messageText.isEmpty else {
            return
        }

        // 先把用户输入追加到聊天列表。
        // 这样用户点击发送后，能马上看到自己的消息。
        // 第二步：先显示用户消息
        messages.append(
            // 用户一点发送，就马上把用户消息追加到列表。
            ChatMessage(role: .user, content: messageText)
        )

        // 第三步：清空输入框，设置状态。
        // 清空输入框，避免用户重复发送同一段内容。
        inputText = ""
        errorMessage = nil
        isSending = true

        // 用 defer 保证函数退出时一定恢复发送状态。
        //
        // 流式输出里可能出现几种退出路径：
        // - 正常收到 done
        // - 网络错误
        // - 后端 SSE error
        // - JSON 解析错误
        //
        // 如果每个分支都手动写 isSending = false，
        // 后续维护时很容易漏掉某个分支。
        // defer：不管这个函数后面怎么结束，离开函数前都执行这段代码。
        defer {
            isSending = false
        }

        // 两个临时变量
        // 这两个变量是为了处理流式回答。
        var assistantMessageID: UUID?
        // 它用来累计所有返回片段。
        var streamedAnswer = ""

        do {
            // Phase 5.5.5 — 确保 thread 存在。
            //
            // 如果 currentThreadID 还是 nil(这是用户首次发消息),
            // 先调后端 POST /api/threads 拿一个新 id 存进来。
            // 之后这次以及后续所有消息,都会带着同一个 id 发,
            // 后端 checkpointer 会自动管理历史。
            //
            // 失败处理:createThread 抛错会直接进入下面的 catch,
            // 显示错误,不会带着 nil threadID fallback 到老路径——
            // 那种 fallback 会让用户以为消息发出去了,实际后续找不回,体验是错乱的。
            if currentThreadID == nil {
                let thread = try await chatAPI.createThread(title: nil)
                currentThreadID = thread.id
            }

            // 调用网络层，请求 Node.js Agent 流式接口。
            //
            // sendAgentStreamingMessage 返回的不是完整答案，
            // 而是一个 AsyncThrowingStream<ChatStreamUpdate, Error>。
            //
            // 后端会先做 Tool Calling：
            // 模型决定是否调用 searchKnowledge / generateQuiz，
            // 后端执行工具并把结果交回模型。
            //
            // 工具阶段会通过 tool_start / tool_done 告诉 iOS 当前进度。
            // 工具阶段完成后，最终回答才会通过 delta 一段段推给 iOS。
            //
            // history 固定传空数组——后端拿到 thread_id 时,
            // 只会用请求里的 message 字段,完整历史从 checkpointer 加载。
            // 继续传 history 是浪费带宽,而且会让"历史的真相在哪"变得不清晰。
            let stream = try chatAPI.sendAgentStreamingMessage(//调网络层拿流式接口 AsyncThrowingStream类似 Kotlin 的 Flow<T>
                messageText,
                systemPrompt: AppConfig.defaultSystemPrompt,
                history: [],
                threadID: currentThreadID
            )

            // 先追加一条空的 AI 消息，给后续 delta 一个固定容器。
            //
            // 这条消息的 id 会被保存下来。
            // 后面每收到一段 delta，都通过这个 id 找到同一条消息并替换 content。
            //
            // 用户消息已经显示了
            //    ↓
            // 马上追加一个空的 AI 消息气泡
            //    ↓
            // 后面流式内容来了
            //    ↓
            // 不断更新这个空气泡
            //后面每收到一段 delta,不是 append 新消息,而是用 ID 找到这条空气泡然后替换 content。这样列表始终是"用户一条 → AI 一条",不会变成"用户一条 → AI 片段 1 → AI 片段 2 → AI 片段 3"。
            let assistantMessage = ChatMessage(role: .assistant, content: "")// 空气泡 就是这里创建了一个空的气泡 然后后续内容就往里添加即可
            assistantMessageID = assistantMessage.id// 记下 ID
            messages.append(assistantMessage)

            // 这个就是读取流式数据。
            //
            // 后端每推送一条 SSE 事件，这里就循环一次。
            // 可能收到三种 update：
            // delta       AI 正文片段
            // toolStart   工具开始执行
            // toolDone    工具执行完成
            for try await update in stream {//for try await ... in stream 是 Swift 异步序列的"消费方式" 等于 Kotlin 的 flow.collect { update -> ... }
                switch update {
                case .delta(let delta):// 文本片段
                    //收到 delta:累积并更新 UI
                    streamedAnswer += delta

                    if let assistantMessageID {
                        updateMessageContent(
                            id: assistantMessageID,
                            content: streamedAnswer
                        )
                    }

                case .toolStart(let toolUpdate):// 工具开始
                    if let assistantMessageID {
                        updateAgentToolStep(
                            messageID: assistantMessageID,
                            update: toolUpdate,
                            status: .running
                        )
                    }

                case .toolDone(let toolUpdate):// 工具结束
                    if let assistantMessageID {
                        updateAgentToolStep(
                            messageID: assistantMessageID,
                            update: toolUpdate,
                            status: toolUpdate.ok == false ? .failed : .completed
                        )
                    }

                case .toolPending(let pending):
                    // Phase 9 #3 — HITL: 工具调用挂起,等用户审批。
                    // 1. 记下当前气泡 id 和已累积文本,resume 后续接
                    // 2. 把 pending 暴露给 UI,触发 sheet 弹出
                    // 后端会紧接着发 done 事件(pending 也会再带一份双保险)。
                    suspendedMessageID = assistantMessageID
                    suspendedStreamedAnswer = streamedAnswer
                    pendingApproval = pending

                case .done(let runID, let pending):
                    // Phase 10.1 #4 — 把 LangSmith 根 run id 写到这条 AI 消息上。
                    //
                    // runID 可能为 nil(后端没启用 LangSmith / 没拿到根 run id)——
                    // 那就保持 message.runId = nil,MessageBubbleView 不显示反馈按钮,
                    // 行为自然降级,不需要在这里做任何特殊处理。
                    if let runID, let assistantMessageID {
                        updateMessageRunId(id: assistantMessageID, runId: runID)
                    }

                    // Phase 9 #3 — done.pending 是双保险:如果 tool_pending SSE
                    // 由于网络抖动丢了,这里也能让 UI 知道挂起。
                    // 已经设过就不重复设(避免 sheet 被同一个 id 重弹)。
                    if let pending, pendingApproval?.toolCallID != pending.toolCallID {
                        suspendedMessageID = assistantMessageID
                        suspendedStreamedAnswer = streamedAnswer
                        pendingApproval = pending
                    }
                }
            }

            // 如果后端正常结束，但没有任何文本片段，
            // 这通常表示模型返回异常或上游没有输出内容。
            // 这里复用已有 emptyAnswer 错误，给用户一个明确提示。
            //
            // Phase 9 #3 — HITL 挂起场景例外:模型可能直接 tool_call 不发任何 delta,
            // 然后流就因为 interrupt 自然结束。pendingApproval 非 nil 说明
            // 我们在等用户审批,**不是**模型异常,跳过这个检查。
            if pendingApproval == nil
                && streamedAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                throw ChatAPIError.emptyAnswer
            }
        } catch {
            // 如果错误发生在还没收到任何 delta 之前，
            // 页面上会留下一个空白 AI 气泡。
            // 这种气泡没有信息量，所以直接移除。
            //
            // 如果已经收到部分内容，则保留 partial answer，
            // 同时显示错误提示，方便用户知道回答中途断了。
            //
            // Phase 9 #3 — 挂起态下也保留空气泡:resume 续跑后会往里填内容,
            // 如果这里移掉了,用户审批完会看到一条"凭空冒出来的"新气泡。
            if pendingApproval == nil
                && streamedAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let assistantMessageID {
                messages.removeAll { $0.id == assistantMessageID }
            }

            // 出错时不崩溃，而是把错误显示在页面上。
            errorMessage = error.localizedDescription
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase 9 #3 — HITL Approve / Reject
    // ─────────────────────────────────────────────────────────────────────
    //
    // # 完整时序(用户在卡片上点完按钮之后)
    //
    //   t0  用户点[批准]或[拒绝]
    //        ↓
    //   t1  ChatView 闭包: Task { await viewModel.approvePending() }
    //        ↓                              (或 rejectPending)
    //   t2  approvePending → resolvePending(approved: true, editedArgs: nil)
    //        ↓
    //   t3  ★ pendingApproval = nil
    //         → SwiftUI .sheet(item:) 检测到 binding 变 nil,sheet 关闭
    //        ↓
    //   t4  发 POST /api/threads/:id/resume → 后端用 Command(resume) 续跑图
    //        ↓
    //   t5  for try await update in stream { ... }
    //         ├ .delta       → append 到原气泡(suspendedMessageID)
    //         ├ .toolStart/Done → 展示新一轮工具进度
    //         ├ .toolPending → 去重判断,可能弹新 sheet(模型连环挂起)
    //         └ .done        → 写 runId,清挂起状态
    //
    // # 为什么把 pendingApproval 清空放在 resolvePending 第一行
    //
    // 卡片关闭由 SwiftUI 的 `.sheet(item: $pendingApproval)` 驱动:
    // binding 变 nil → sheet 自动 dismiss。
    //
    // 我们 **不在** ToolApprovalCard 里直接调 dismiss(),因为:
    //   - dismiss() 是 SwiftUI 的环境 action,运行时机不确定
    //   - 如果 dismiss 比 Task 里的 resolvePending 先跑,binding 已 nil,
    //     guard 失败 → resume 永远不发(这就是历史上踩过的 bug)
    //
    // 让 VM 当 pendingApproval 的唯一控制者,行为可预测。

    /// 用户在审批卡片上点[批准]。
    /// editedArgs == nil 表示用原参数;非 nil 表示用编辑过的参数。
    /// (当前 UI 还不支持编辑,但 API 留好了口子。)
    func approvePending(editedArgs: [String: JSONValue]? = nil) async {
        await resolvePending(approved: true, editedArgs: editedArgs)
    }

    /// 用户在审批卡片上点[拒绝]。
    ///
    /// 后端收到 approved=false 后,会在 toolNode 里塞一条
    /// `{ ok: false, status: "user_rejected" }` 的 ToolMessage 给模型,
    /// 配合 agentOutputGuide 里的指令,模型会简短道歉并问"想干啥",
    /// **不会再尝试调同一个工具**,也**不会自己手写答案**。
    func rejectPending() async {
        await resolvePending(approved: false, editedArgs: nil)
    }

    /// 共用的 resume 实现 —— 批准 / 拒绝路径只差 approved 一个布尔值。
    ///
    /// 关键步骤(按顺序):
    ///   1. 校验有挂起态 + 有 thread id(防御性)
    ///   2. 记下 justResumedToolCallID(用于回声去重,见上面字段注释)
    ///   3. **立刻清空 pendingApproval** → sheet 自动关闭
    ///   4. 发 /resume 拿到新 SSE 流
    ///   5. 在循环里复用 sendMessage 的逻辑(同样的 update case 分发)
    ///   6. 流里收到 toolPending 时按 toolCallID 去重
    ///   7. 流到 done(pending: nil) 时清挂起痕迹
    private func resolvePending(
        approved: Bool,
        editedArgs: [String: JSONValue]?
    ) async {
        // 防御:没有挂起态就不该走到这里(UI 已经把卡片关掉了)
        guard let currentPending = pendingApproval,
              let threadID = currentThreadID else {
            return
        }

        // ★ 关键 1: 记下"刚批准的 tool_call_id"
        // resume 流里再收到同 id 的 tool_pending 是后端 toolNode 重跑的回声,
        // 要忽略;否则 sheet 会重弹,用户再点一次批准 → /resume 又发一次 →
        // 工具被执行两次。这是历史上踩过的 bug,这一行就是它的疫苗。
        justResumedToolCallID = currentPending.toolCallID

        // ★ 关键 2: 立刻把 pendingApproval 清空,卡片消失,UI 进入"AI 正在回复"态
        // (见上面"为什么把 pendingApproval 清空放在 resolvePending 第一行"那段)
        pendingApproval = nil
        errorMessage = nil
        isSending = true

        defer { isSending = false }

        // 复用挂起前已经累积的文本 + 气泡 id
        // 这样 resume 后的新 delta 会接到**同一个气泡**上,
        // 视觉上是"思考被中断审批了一下,继续回答",而不是两条消息。
        var streamedAnswer = suspendedStreamedAnswer
        let assistantMessageID = suspendedMessageID

        do {
            let stream = try chatAPI.resumeThread(
                threadID: threadID,
                approved: approved,
                editedArgs: editedArgs
            )

            for try await update in stream {
                switch update {
                case .delta(let delta):
                    streamedAnswer += delta
                    if let assistantMessageID {
                        updateMessageContent(id: assistantMessageID, content: streamedAnswer)
                    }

                case .toolStart(let toolUpdate):
                    if let assistantMessageID {
                        updateAgentToolStep(
                            messageID: assistantMessageID,
                            update: toolUpdate,
                            status: .running
                        )
                    }

                case .toolDone(let toolUpdate):
                    if let assistantMessageID {
                        updateAgentToolStep(
                            messageID: assistantMessageID,
                            update: toolUpdate,
                            status: toolUpdate.ok == false ? .failed : .completed
                        )
                    }

                case .toolPending(let pending):
                    // 关键去重:resume 时后端 toolNode 会从头重跑,
                    // interrupt 之前的代码(包括 onToolEvent)会再次执行,
                    // iOS 会收到同一个 tool_call_id 的第二条 tool_pending。
                    // 这是回声,不是真正的新挂起,直接忽略。
                    if pending.toolCallID == justResumedToolCallID {
                        break
                    }
                    // 真正的新挂起:模型批准了 A 工具,又决定调 B 工具(需审批)
                    suspendedStreamedAnswer = streamedAnswer
                    // suspendedMessageID 保持不变(还是同一个气泡)
                    pendingApproval = pending

                case .done(let runID, let pending):
                    if let runID, let assistantMessageID {
                        updateMessageRunId(id: assistantMessageID, runId: runID)
                    }
                    if let pending,
                       pending.toolCallID != justResumedToolCallID,
                       pendingApproval?.toolCallID != pending.toolCallID {
                        // 真正的新挂起(同样要排除回声)
                        suspendedStreamedAnswer = streamedAnswer
                        pendingApproval = pending
                    } else if pending == nil {
                        // 真正结束了,清掉挂起痕迹和回声去重 id
                        suspendedMessageID = nil
                        suspendedStreamedAnswer = ""
                        justResumedToolCallID = nil
                    }
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Phase 5.6 — 从后端加载已有对话的历史消息并显示。
    ///
    /// 调用时机:ChatView 在 `.task` 里调,带着对话列表页传进来的 threadID。
    ///
    /// 完整流程:
    ///   1. isLoadingHistory = true,errorMessage 清空
    ///   2. GET /api/threads/:id/messages
    ///   3. ThreadMessage[] → ChatMessage[](过滤掉未知 role,只保留 user / assistant)
    ///   4. 替换 messages 数组(覆盖,不追加)
    ///   5. 加载成功才把 currentThreadID 设上——保证 invariant:
    ///      "currentThreadID 非 nil ⇒ iOS 端有完整历史"
    ///   6. defer 兜底设 isLoadingHistory = false
    ///
    /// 失败处理:errorMessage 显示后端/网络错误,currentThreadID 保持 nil,
    /// messages 保持空(由 UI 自己决定要不要显示"加载失败,点这里重试")。
    /// 这种状态下用户**不能继续发消息**——sendMessage 会以为是新对话,createThread
    /// 创建一个新的——这是合理的兜底,虽然用户会觉得"我点的是 A 对话怎么变成新对话了",
    /// 但比"继续追加到一个不知道历史的 thread"要好。
    func loadThread(threadID: String) async {
        isLoadingHistory = true
        errorMessage = nil

        // defer 保证不管成功/失败/抛错,都会把 loading 状态恢复。
        // 不用每个分支手动 set,避免"漏掉某个 return 路径"的低级 bug。
        defer { isLoadingHistory = false }

        do {
            let threadMessages = try await chatAPI.getThreadMessages(threadID: threadID)

            // compactMap:过滤 + 转换二合一。
            // ThreadMessage.role 是 String("user" / "assistant"),
            // 用 ChatMessageRole(rawValue:) 解析——后端理论上只发这两个值,
            // 但万一未来后端扩展了 role(system / tool),iOS 老版本拿到不认识的 role
            // 应该静默丢弃,而不是崩溃或显示乱码。
            messages = threadMessages.compactMap { threadMessage in
                guard let role = ChatMessageRole(rawValue: threadMessage.role) else {
                    return nil
                }
                return ChatMessage(role: role, content: threadMessage.content)
            }

            // 只有加载成功才设 currentThreadID。见 init 注释里说的 invariant。
            currentThreadID = threadID
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// 清空聊天记录，保留一条欢迎语。
    ///
    /// Phase 5.5.5 起,"清空"按钮的语义升级为"开始一段新对话":
    ///   - 把 currentThreadID 切回 nil → 下次发消息会调 createThread 拿新 id
    ///   - 不调 deleteThread——历史 thread 还在数据库里,
    ///     5.6 的对话列表 UI 可以让用户回到那个对话
    func resetConversation() {
        messages = [
            ChatMessage(
                role: .assistant,
                content: "聊天已清空。你可以继续问我新的问题。"
            )
        ]
        inputText = ""
        errorMessage = nil
        isSending = false
        currentThreadID = nil
    }

    /// 去掉输入框前后的空格和换行。
    /// 用户只输入空格时，也会被当成空消息。
    private var trimmedInputText: String {
        inputText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 更新某一条消息的正文。
    ///
    /// 流式输出时，后端会持续返回 delta。
    /// 我们不追加新消息，而是不断替换同一条 assistant 消息的 content。
    ///
    /// 这样聊天列表始终保持：
    /// 用户一条消息 -> AI 一条消息
    ///
    /// 而不是：
    /// 用户一条消息 -> AI 片段 1 -> AI 片段 2 -> AI 片段 3
    private func updateMessageContent(id: UUID, content: String) {
        // 根据 id 找到 messages 里对应的消息下标。
        // 如果找不到，直接 return。
        // 如果找到了，用新的 content 替换它。
        guard let index = messages.firstIndex(where: { $0.id == id }) else {
            return
        }

        messages[index] = messages[index].updatingContent(content)
    }

    /// Phase 10.1 #4 — 流结束时把 LangSmith 根 run id 写到这条 AI 消息上。
    /// 用 id 找位置 + 调 Message.updatingRunId,和 updateMessageContent 套路一致。
    private func updateMessageRunId(id: UUID, runId: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else {
            return
        }
        messages[index] = messages[index].updatingRunId(runId)
    }

    /// Phase 10.1 #4 — 提交一条 AI 消息的反馈到后端,后端会写到 LangSmith。
    ///
    /// 设计:**乐观更新 + 失败回滚**
    ///   1. 立刻把 message.feedbackScore 设上(按钮立刻置灰,反应灵敏)
    ///   2. 异步调 POST /api/feedback
    ///   3. 失败时把 feedbackScore 还原成 nil,显示错误
    ///
    /// 为什么乐观:网络往返几百毫秒,用户点完按钮要等才置灰会觉得"按了没反应"。
    /// 后端校验也很严格(score 必须 0..1, runId 必须存在),失败概率低,
    /// 用"先动手再补救"的模式换更顺畅的交互。
    ///
    /// 校验:
    ///   - 消息存在且有 runId 才提交。没 runId 不该走到这里(UI 也不会显示按钮),
    ///     但加守卫防御 SwiftUI 状态时序问题。
    ///   - feedbackScore 已有值就直接 return(防双击)
    func submitFeedback(messageID: UUID, score: Double) async {
        guard let index = messages.firstIndex(where: { $0.id == messageID }) else {
            return
        }
        let message = messages[index]
        guard let runID = message.runId else {
            return
        }
        // 已经反馈过就忽略——前端按钮在 feedbackScore 非 nil 时已经 disabled,
        // 这里再加一道防御,挡住意外重入。
        guard message.feedbackScore == nil else {
            return
        }

        // 乐观更新:先在 UI 上置成"已反馈"。
        messages[index] = message.updatingFeedbackScore(score)

        do {
            try await chatAPI.submitFeedback(runID: runID, score: score)
        } catch {
            // 失败回滚:把 feedbackScore 改回 nil,按钮重新可点;
            // 同时显示错误,让用户知道为什么"按了又退回去"。
            //
            // 注意:回滚时要重新找 index——异步等待期间 messages 可能已经被改过
            // (用户新发了消息 / 切了对话)。如果找不到原消息,静默放弃回滚——
            // 那条消息已经不在视图里了,回滚也没意义。
            if let nowIndex = messages.firstIndex(where: { $0.id == messageID }) {
                messages[nowIndex] = messages[nowIndex].updatingFeedbackScore(nil)
            }
            errorMessage = "反馈提交失败:\(error.localizedDescription)"
        }
    }

    /// 更新某条 AI 消息里的 Agent 工具执行步骤。
    ///
    /// tool_start 和 tool_done 使用同一个 toolCallID。
    /// 如果已经存在对应步骤，就更新状态和文案；
    /// 如果不存在，就追加一条新步骤。
    ///
    /// 这样 UI 能展示：
    /// - 正在查询知识库
    /// - 已查询知识库，找到 2 条相关资料
    private func updateAgentToolStep(
        messageID: UUID,
        update: AgentToolUpdate,
        status: AgentToolStepStatus
    ) {
        // 先在 messages 里找到当前那条 assistant 消息。
        // 找不到就直接退出。
        guard let messageIndex = messages.firstIndex(where: { $0.id == messageID }) else {
            return
        }

        // 创建 AgentToolStep。
        // 这里把后端返回的 AgentToolUpdate 转成 UI 使用的 AgentToolStep。
        //
        // AgentToolUpdate：
        // 后端流式事件里的工具更新数据。
        //
        // AgentToolStep：
        // 前端消息气泡里展示的工具步骤。
        let step = AgentToolStep(
            id: update.toolCallID,
            toolName: update.toolName,
            displayName: update.displayName,
            status: status,
            message: update.message
        )

        // 取出已有 steps，一条 AI 消息里可以有多个工具步骤。
        var steps = messages[messageIndex].agentToolSteps

        // 如果已有，就更新；如果没有，就追加。
        if let stepIndex = steps.firstIndex(where: { $0.id == step.id }) {
            steps[stepIndex] = step
        } else {
            steps.append(step)
        }

        // 写回 messages。
        messages[messageIndex] = messages[messageIndex].updatingAgentToolSteps(steps)
    }
}
