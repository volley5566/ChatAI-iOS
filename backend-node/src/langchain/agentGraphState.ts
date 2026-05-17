import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

/**
 * Phase 4 — LangGraph State Schema。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一个文件是 LangGraph 学习的"基石",一定要看懂。
 * ─────────────────────────────────────────────────────────────────────
 *
 * # 什么是 State?
 *
 * LangGraph 的核心模型是"图":有节点(Node)、有边(Edge)。
 * 每个节点跑完之后会修改一个共享的"状态对象",下一个节点拿到的就是
 * 修改后的状态。这个共享对象就叫 State。
 *
 * 你可以把 State 想成"一张运行中不断更新的小白板":
 *   ┌──────────────────────────────────┐
 *   │ messages:        [...所有对话]    │
 *   │ modelCallCount:  3                │
 *   │ toolCallCount:   1                │
 *   └──────────────────────────────────┘
 * 节点 A 读它、写它,节点 B 接力读它、写它,直到图跑完。
 *
 *
 * # 为什么不用普通 TypeScript 对象?
 *
 * 因为 State 改的时候不是"覆盖"那么简单——
 * 比如 messages 应该是"追加"而不是"替换"。
 *
 * LangGraph 给每个字段配了 **reducer**(归并函数),由它决定"新旧值怎么合并"。
 * 不同字段用不同 reducer:
 *   - messages:      追加(新消息加到列表末尾)
 *   - 计数器:        累加(新值 + 旧值)
 *   - 标志位:        覆盖(直接替换)
 *
 *
 * # Annotation 是什么?
 *
 * Annotation 是 LangGraph 用来"描述一个 state 字段"的工具。
 * 它告诉图:
 *   1. 这个字段类型是什么(TypeScript 编译期信息)
 *   2. 这个字段的 reducer 是什么(运行期合并规则)
 *   3. 这个字段的默认值是什么(图启动时的初始状态)
 *
 *
 * # MessagesAnnotation 是 LangGraph 预设
 *
 * 因为 99% 的 Agent 都需要 `messages: BaseMessage[]` 这个字段,
 * 而且 reducer 都是"追加",LangGraph 干脆提供了一个现成的:
 *
 *   MessagesAnnotation.spec.messages
 *     ≈ Annotation<BaseMessage[]>({
 *         reducer: messagesStateReducer,  // 智能追加:支持插入 / 替换 / 删除
 *         default: () => [],
 *       })
 *
 * 我们用 `...MessagesAnnotation.spec` 把它"展开"进自己的 State,
 * 后面再加自己的字段(modelCallCount / toolCallCount)。
 */
export const AgentState = Annotation.Root({
  /**
   * 对话消息列表,直接复用 LangGraph 预设。
   *
   * 这条等价于手写:
   *   messages: Annotation<BaseMessage[]>({
   *     reducer: messagesStateReducer,
   *     default: () => [],
   *   })
   *
   * messagesStateReducer 比朴素的 [...old, ...new] 更聪明:
   *   - 新消息按 id 去重(同 id 视为"更新"而不是"再加一条")
   *   - 支持 REMOVE_ALL_MESSAGES 哨兵清空历史
   *   - 支持流式 chunk 累积成完整消息
   *
   * 一句话:**直接用预设,不用自己造轮子**。
   */
  ...MessagesAnnotation.spec,

  /**
   * 已发起的模型调用次数。
   *
   * Phase 3 用 `modelCallLimitMiddleware` 在 createAgent 内部计数;
   * Phase 4 我们自己手写图,所以把计数器搬到 state 里。
   *
   * reducer 是"累加":每个节点 return { modelCallCount: 1 } 表示"我又调了一次"。
   * 累加意味着图任何位置都能 += 1,不需要先读再写。
   */
  modelCallCount: Annotation<number>({
    reducer: (current, update) => (current ?? 0) + (update ?? 0),
    default: () => 0,
  }),

  /**
   * 已执行的工具次数。
   *
   * 用法和 modelCallCount 一样,toolNode 完成一次就 += 1。
   *
   * 注意它和 LangChain Phase 3 的 `toolCallLimitMiddleware` 是同一概念,
   * 不过那时 middleware 帮我们偷偷做了;现在我们手写,所以暴露在 state 里、
   * 在 agentNode 里检查"是否超额"。
   */
  toolCallCount: Annotation<number>({
    reducer: (current, update) => (current ?? 0) + (update ?? 0),
    default: () => 0,
  }),
});

/**
 * 给 state 一个具体的 TypeScript 类型别名,后面 agentNode / toolNode 的
 * 参数类型直接用 `AgentStateType` 就行,不必每次写一长串泛型。
 *
 * Annotation.Root(...).State 是 LangGraph 提供的一个类型工具,
 * 它会从 Annotation 定义中**自动推导出**对应的 TypeScript 类型,
 * 等价于:
 *   {
 *     messages: BaseMessage[];
 *     modelCallCount: number;
 *     toolCallCount: number;
 *   }
 *
 * 好处:state schema 改字段时,所有用到 AgentStateType 的地方自动跟着变,
 * 不会出现"运行时是 4 个字段,类型里只声明了 3 个"这种悄悄失配的 bug。
 */
export type AgentStateType = typeof AgentState.State;

/**
 * 节点返回值的类型。
 *
 * LangGraph 的节点不需要返回完整的 state,只需要返回**自己改动过的字段**,
 * 框架会用对应 reducer 合并进总 state。
 *
 * 比如 agentNode 只关心 messages 和 modelCallCount,就返回:
 *   { messages: [新消息], modelCallCount: 1 }
 * 不需要管 toolCallCount。
 *
 * Partial<...> 表示"所有字段可选",符合这个语义。
 */
export type AgentStateUpdate = Partial<AgentStateType>;
