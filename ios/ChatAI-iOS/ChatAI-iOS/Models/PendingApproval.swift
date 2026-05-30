//
//  PendingApproval.swift
//  ChatAI-iOS
//
//  Phase 9 #3 — HITL (Human-in-the-Loop) 模型。
//

import Foundation

/// 后端 Agent 在调用 LLM-as-tool(evaluateAnswer / generateQuiz /
/// recommendNextTopic)之前会先发一个 `tool_pending` SSE 事件,
/// 把 tool_call_id + 参数交给 iOS,等用户在卡片上点[批准]或[拒绝]。
///
/// iOS 收到这个数据后:
///   1. ChatViewModel 把它存到 @Published pendingApproval
///   2. ChatView 在 sheet 里展示一张审批卡片
///   3. 用户点完按钮,VM 调 ChatAPI.resumeThread(...) 续跑
///
/// 跟后端 PendingToolApproval 结构对齐(字段名走 snake_case 自动转 camelCase)。
struct PendingApproval: Equatable, Identifiable {
    /// SwiftUI `.sheet(item:)` 要求 Identifiable —— 用 toolCallID 作为 id 就行。
    /// 同一 thread 连续两次挂起会有不同的 toolCallID,sheet 会正确重弹。
    var id: String { toolCallID }

    /// LangChain 生成的 tool_call_id,用来对齐审批与最终工具执行结果。
    /// iOS 把它原样回传(实际上后端 resume 时不强校验这个 id,因为
    /// graph state 自己知道挂起在哪个 task 上,但保留它方便日志对齐)。
    let toolCallID: String

    /// 工具名(searchKnowledge / generateQuiz / evaluateAnswer / recommendNextTopic)。
    let toolName: String

    /// 中文展示名,后端已经映射好,直接用就行。
    let displayName: String

    /// 工具参数,由模型生成。
    /// 用 [String: JSONValue] 是因为 JSON 是异构的——
    /// generateQuiz 可能传 {"topic": "...", "count": 3},
    /// recommendNextTopic 可能传 {"recentTopics": ["@State", "@Binding"]},
    /// 不可能预定义一个固定的 Swift struct 覆盖所有工具。
    let args: [String: JSONValue]
}

/// 通用 JSON 值,递归覆盖 JSON Spec 的所有形态。
///
/// # 为什么要自己写?
///
/// Swift 的 Codable 默认不支持 `Any`,所以 `[String: Any]` 不能直接 Decode。
/// 工具的 args 是异构 JSON(generateQuiz 是 `{topic, count}`,
/// recommendNextTopic 是 `{recentTopics: [...]}`),没法预定义一个 struct。
/// 开源 AnyCodable 库能解决,但学习项目里不想引 dependency,就自己写 30 行。
///
/// 顺便能学到 Codable 的两个核心 API:
///   - `singleValueContainer()` 拿到"裸值"容器,可以反复 try? decode 不同类型
///   - 递归 Decodable: `[JSONValue]` 和 `[String: JSONValue]` 自然嵌套
///
/// # 实际 args 长什么样
///
///   generateQuiz:        `{"topic": "SwiftUI @State", "count": 3}`
///   evaluateAnswer:      `{"question": "...", "userAnswer": "...", "expectedConcepts": ["@State", "binding"]}`
///   recommendNextTopic:  `{"recentTopics": ["@State"], "focusArea": "SwiftUI", "count": 3}`
///
/// 都能用 JSONValue 完整解出来。
enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        // ★ 解码顺序很重要 ★
        //
        // singleValueContainer 让你"试探"每种类型,试不到就抛错,我们 try? 接住继续试下一种。
        // 顺序错了会有微妙 bug:
        //
        //   1. null  → 单独 API decodeNil(),必须第一个,因为 nil 不能被 decode 成具体类型
        //   2. Bool  → ★ 必须在 Double 之前!★
        //              Swift 的 JSONDecoder 在某些版本会把 true/false 解析成 1.0/0.0,
        //              如果先试 Double 成功了,就拿不到正确的 .bool 分支了。
        //   3. Double → 数字(整数 / 小数都用 Double 接,encode 时再判断是否要写成 Int)
        //   4. String → 字符串
        //   5. Array  → 递归:[JSONValue]
        //   6. Object → 递归:[String: JSONValue]
        if container.decodeNil() {
            self = .null
            return
        }
        if let v = try? container.decode(Bool.self) {
            self = .bool(v)
            return
        }
        if let v = try? container.decode(Double.self) {
            self = .number(v)
            return
        }
        if let v = try? container.decode(String.self) {
            self = .string(v)
            return
        }
        if let v = try? container.decode([JSONValue].self) {
            self = .array(v)
            return
        }
        if let v = try? container.decode([String: JSONValue].self) {
            self = .object(v)
            return
        }

        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "JSONValue: 不支持的 JSON 类型"
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let v):
            try container.encode(v)
        case .number(let v):
            // 整数走 Int 编码,避免 5 变成 5.0
            if v.truncatingRemainder(dividingBy: 1) == 0 && abs(v) < Double(Int.max) {
                try container.encode(Int(v))
            } else {
                try container.encode(v)
            }
        case .string(let v):
            try container.encode(v)
        case .array(let v):
            try container.encode(v)
        case .object(let v):
            try container.encode(v)
        }
    }

    /// 用来在 UI 卡片上显示一个简洁的字符串。
    /// 嵌套对象/数组直接 JSON.stringify,避免无限递归 UI。
    var displayString: String {
        switch self {
        case .string(let s):
            return s
        case .number(let n):
            return n.truncatingRemainder(dividingBy: 1) == 0
                ? String(Int(n))
                : String(n)
        case .bool(let b):
            return b ? "true" : "false"
        case .null:
            return "null"
        case .array, .object:
            // 顶层 array / object 一般在 UI 上少见(args 顶层是 object),
            // 这里兜底用 JSONEncoder 转一下,保证不出现 "Optional(...)" 这种乱七八糟。
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            if let data = try? encoder.encode(self),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
            return "..."
        }
    }
}
