# SwiftUI @State

Keywords: SwiftUI, @State, state, 状态, View, UI 刷新, 入门

`@State` 是 SwiftUI 中用于在当前 View 内部保存简单状态的属性包装器。

当 `@State` 的值改变时，SwiftUI 会重新计算当前 View 的 `body`，并自动刷新界面。

## 适合保存什么

`@State` 适合保存只属于当前页面或当前组件的小状态。

常见例子：

- 输入框文字
- 开关是否打开
- 计数器数字
- 是否显示弹窗
- 当前选中的按钮

## 简单例子

```swift
struct CounterView: View {
    @State private var count = 0

    var body: some View {
        VStack {
            Text("Count: \(count)")

            Button("Add") {
                count += 1
            }
        }
    }
}
```

当点击按钮时，`count` 改变，页面上的 `Text` 会自动更新。

## 初学者理解

可以把 `@State` 理解成：

```text
这个 View 自己拥有的一份可变化数据。
数据变了，界面自动跟着变。
```

## 注意事项

`@State` 一般用于简单值，比如：

- `String`
- `Int`
- `Bool`
- 小型结构体

如果状态需要被多个页面共享，通常不应该继续使用 `@State`，而应该考虑 `ObservableObject`、`@StateObject`、`@ObservedObject` 或更完整的数据管理方式。

