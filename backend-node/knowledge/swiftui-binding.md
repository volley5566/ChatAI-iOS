# SwiftUI @Binding

Keywords: SwiftUI, @Binding, state, parent view, child view, 数据绑定, 双向绑定

`@Binding` 用于让子 View 读写父 View 传进来的状态。

它自己不保存数据，只是连接到外部的一份数据。

## 和 @State 的关系

常见搭配是：

```text
父 View 使用 @State 保存真正的数据
子 View 使用 @Binding 修改父 View 的数据
```

## 简单例子

父 View：

```swift
struct ParentView: View {
    @State private var name = ""

    var body: some View {
        NameInputView(name: $name)
    }
}
```

子 View：

```swift
struct NameInputView: View {
    @Binding var name: String

    var body: some View {
        TextField("Input name", text: $name)
    }
}
```

这里的 `$name` 表示传递绑定关系，而不是只传递一个普通字符串。

## 初学者理解

可以把 `@Binding` 理解成：

```text
子 View 没有自己的数据本体，
但它拿到了一根线，
这根线连接着父 View 的数据。
```

子 View 修改 `@Binding`，父 View 里的 `@State` 也会跟着变。

## 在当前项目中的例子

聊天输入框 `ChatInputBar` 使用 `@Binding` 接收输入文字。

这样输入框组件可以修改 `ChatViewModel.inputText`，但它不需要自己管理完整的聊天状态。

