# LangGraph 核心概念

Keywords: LangGraph, StateGraph, checkpointer, thread_id, MessagesState, reducer, persistence, state machine, Agent, multi-turn conversation, 状态图, 持久化, 多轮对话

LangGraph 是 LangChain 团队推出的"用状态图组织 LLM 应用"的库。它把 Agent 的执行过程显式表达成一个**节点 + 边**的图，让你能精确控制 LLM 在每一步做什么。

## 为什么需要 LangGraph

最早写 AI 应用是这样的：

```text
用户问 -> LLM 回答 -> 结束
```

加上工具调用后变成：

```text
用户问 -> LLM 决定 -> 调用工具 -> 把结果给 LLM -> LLM 回答 -> 结束
```

如果模型决定连续调用多个工具，就变成循环。LangChain 早期的 `AgentExecutor` 是把这个循环写死在框架里的——你想插一步"先验证用户身份"或"中间存档"都没法做。

LangGraph 把这个流程**显式化**：每一步是一个 node，每个 node 之间用 edge 连接。你想加一步就加一个 node，你想分支就加 conditional edge。

## StateGraph 是什么

`StateGraph` 是 LangGraph 的核心类。它的工作模型是：

```text
一份共享 State
     |
     v
[node A] 读 State -> 返回部分更新 -> State 自动合并
     |
     v
[node B] 读 State -> 返回部分更新 -> State 自动合并
     |
     v
END
```

每个节点是一个普通的函数（或异步函数）：

```typescript
async function modelNode(state: AgentState): Promise<Partial<AgentState>> {
  const response = await llm.invoke(state.messages);
  return { messages: [response] };
}
```

节点只返回**要改的部分**，框架负责合并到完整 State。这种 reducer 模式让节点之间彻底解耦——节点不需要知道 State 还有哪些字段。

## Reducer：State 怎么合并

State 里每个字段都可以配一个 reducer 函数。最常用的是 `messagesStateReducer`：

```typescript
const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,  // 默认行为：追加新消息
    default: () => [],
  }),
});
```

`messagesStateReducer` 的语义是"追加"：节点返回 `{ messages: [newMsg] }`，框架会把 `newMsg` **append** 到现有数组后面，而不是覆盖。

这是 LangGraph 多轮对话的关键——你不需要手动维护 history，每次新消息自动追加到 State 里。

## Checkpointer：State 持久化

LangGraph 内置 checkpointer 机制，每个 node 执行完后会把当前 State 写入存储：

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const checkpointer = SqliteSaver.fromConnString("./checkpoints.db");
const graph = workflow.compile({ checkpointer });
```

调用时传入 `thread_id`，LangGraph 会：

1. 从存储里把这个 thread_id 对应的 State 加载出来
2. 执行图，State 经过所有节点
3. 把最终 State 写回存储

下次同一个 thread_id 再来，State 自动接着上次。整个"多轮对话记忆"就这样实现了——你完全不用手动管理 history 数组。

## thread_id 的作用

`thread_id` 是 checkpointer 的"主键"。它把"哪段对话属于谁"区分开：

```typescript
await graph.invoke(
  { messages: [new HumanMessage(userInput)] },
  { configurable: { thread_id: "user-123-conv-456" } }
);
```

不同 `thread_id` 的 State 完全隔离。同一个 `thread_id` 跨进程重启也能继续——因为 State 已经在 SQLite 里。

## 整体心智模型

把 LangGraph 想成"**带持久化的状态机**"：

- **状态机**：图描述了流程，节点描述了每步做什么
- **带持久化**：每步执行后状态自动存盘，下次接着跑

这套机制让"多轮对话"、"长任务断点续传"、"Human-in-the-loop 审批流"都变成同一套底层模型的应用。
