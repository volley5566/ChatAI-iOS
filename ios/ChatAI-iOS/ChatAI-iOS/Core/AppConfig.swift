//
//  AppConfig.swift
//  ChatAI-iOS
//
//  Created by Nathan on 2026/5/12.
//

import Foundation

/// AppConfig 专门放“全局配置”。
///
/// 初学者可以先记住：
/// - View 负责显示界面
/// - ViewModel 负责页面状态和业务流程
/// - Service 负责网络请求
/// - Config 负责保存一些固定配置，比如后端地址
enum AppConfig {
    /// Node.js 后端地址。
    ///
    /// 现在后端监听的是：
    /// http://localhost:8000
    ///
    /// iOS 模拟器运行在你的 Mac 上，所以模拟器访问 127.0.0.1:8000
    /// 就等于访问 Mac 本机启动的 Node.js 服务。
    ///
    /// 如果你以后用真机调试，这里不能继续写 127.0.0.1，
    /// 因为真机里的 127.0.0.1 指的是“手机自己”，不是你的 Mac。
    /// 真机调试时要改成你的 Mac 局域网 IP，例如：
    /// http://192.168.1.23:8000
    static let backendBaseURL = URL(string: "http://127.0.0.1:8000")!

    /// 给后端传的 system_prompt。
    ///
    /// 后端的 server.ts 里支持 system_prompt 字段。
    /// 它相当于告诉 AI：“请用什么身份、什么风格回答用户”。
    static let defaultSystemPrompt = """
    You are a friendly AI assistant inside an iOS learning demo app.
    Explain answers clearly and simply for a beginner learning SwiftUI and AI apps.
    """
}
