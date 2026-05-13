# Prompt 和结构化输出

Keywords: AI, prompt, system prompt, structured output, JSON, iOS display, RAG

结构化输出的目标是让 AI 不只返回一段自由文本，而是按照固定 JSON 格式返回。

这样 App 可以稳定解析，并按不同字段展示内容。

## 普通文本输出

普通 AI 回答可能是：

```text
SwiftUI 是 Apple 的声明式 UI 框架。@State 用来管理 View 内部状态...
```

这种回答人能读懂，但程序很难稳定拆分标题、摘要和重点。

## 结构化输出

结构化输出要求 AI 返回：

```json
{
  "title": "SwiftUI @State",
  "summary": "@State 用于管理 View 内部的简单状态。",
  "points": [
    "状态改变后界面会刷新",
    "适合简单值类型",
    "通常只在当前 View 内使用"
  ],
  "next_question": "@State 和 @Binding 有什么区别？"
}
```

## 为什么要在后端控制 prompt

结构化输出是后端和 iOS 之间的接口约定。

如果后端承诺返回：

```text
title / summary / points / next_question
```

iOS 就会按这些字段解析和展示。

所以后端必须在 prompt 中明确告诉 AI：

```text
只返回 JSON
不要返回 Markdown
不要加额外解释
必须包含指定字段
```

## 为什么还需要 fallback

即使 prompt 写得很清楚，AI 也可能偶尔没有严格按格式返回。

所以后端不能完全相信 AI。

后端应该：

```text
先尝试 JSON.parse
  -> 成功：返回结构化数据
  -> 失败：把原始回答放进 summary，返回一个默认结构
```

这样 iOS 总能收到稳定格式，不会因为 AI 一次格式错误而崩溃。

## 和 RAG 的关系

RAG 阶段会先从知识库中找资料，再把资料加入 prompt。

最终 prompt 会包含：

```text
角色设定
结构化输出规则
检索到的知识库资料
用户问题
```

AI 会基于资料回答，并继续按照结构化 JSON 返回。

