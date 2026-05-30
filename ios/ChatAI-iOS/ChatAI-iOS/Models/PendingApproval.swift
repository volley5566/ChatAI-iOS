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
/// 为什么要自己写?
///   Swift 的 Codable 默认不支持 Any —— `[String: Any]` 没法 Decodable。
///   开源 AnyCodable 库可以用,但学习项目里不想引一个 dependency 就为这一个类型。
///   30 行代码自己写一个,顺便理解 Codable 的 singleValueContainer 玩法。
enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        // 顺序: 先试 null → bool → number → string → array → object
        // 注意 bool 必须排在 number 前面,否则 true/false 会被当成 1/0 解码进 number 分支。
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
