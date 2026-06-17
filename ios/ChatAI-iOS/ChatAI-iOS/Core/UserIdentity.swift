//
//  UserIdentity.swift
//  ChatAI-iOS
//
//  Phase 12 — 跨对话长期记忆的"用户身份锚点"。
//

import Foundation

/// 本设备的"用户身份"。
///
/// # 它解决什么问题
/// Phase 12 要做"跨对话记忆"——在对话 A 里学到的事实(比如"我在学 SwiftUI"),
/// 到对话 B 也能用上。可记忆必须有归属:这是**谁的**记忆?不能让别人看到。
/// 所以每个请求都要带上一个稳定的用户 id,后端按它给记忆分租户。
///
/// # 为什么是"匿名 UUID"而不是账号登录
/// 这个 Demo 没有账号系统。我们退而求其次:
///   - App 首次启动时,本地生成一个随机 UUID
///   - 存进 UserDefaults(卸载重装才会丢)
///   - 之后每次启动都复用同一个 id
/// 它不代表"真实的人",只代表"这台设备这个安装"。将来真要做登录,
/// 把这里换成"登录后拿到的用户 id"即可,上层网络代码一行都不用改。
///
/// # 为什么用 `static let` + 闭包
/// Swift 的 `static let` 是**懒加载且只执行一次**的(线程安全)。
/// 第一次有人读 `UserIdentity.current` 时才跑闭包:有就读出来、没有就生成并存。
/// 之后这个值被缓存,后续读取不再碰 UserDefaults。正好是"算一次,到处用"。
enum UserIdentity {
    /// UserDefaults 里的存储键。加前缀避免和别的键冲突。
    private static let storageKey = "com.chatai.userID"

    /// 当前设备的用户 id(匿名 UUID 字符串)。
    static let current: String = {
        let defaults = UserDefaults.standard

        // 已经生成过 → 直接复用,保证"同一台设备永远是同一个用户"。
        if let existing = defaults.string(forKey: storageKey), !existing.isEmpty {
            return existing
        }

        // 首次启动 → 生成一个新 UUID 并持久化。
        let generated = UUID().uuidString
        defaults.set(generated, forKey: storageKey)
        return generated
    }()
}
