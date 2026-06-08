import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/agentGraphState.ts — LangGraph State Schema
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   agentGraph.ts 用这个 schema 调 new StateGraph(AgentState) 来建图。
 *
 * 这是 LangGraph 学习的"基石",一定要看懂。
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
   * 在 createAgent 路径里 `modelCallLimitMiddleware` 帮你计数;
   * 这里我们手写图,所以把计数器暴露在 state 里。
   *
   * reducer 是"累加":每个节点 return { modelCallCount: 1 } 表示"我又调了一次"。
   * 累加意味着图任何位置都能 += 1,不需要先读再写。
   */
  modelCallCount: Annotation<number>({
    // Phase 11 fix — 支持"重置"协议:
    //   update === 0  → 重置成 0(给 resetCountersNode 用,每次新请求开始时清零)
    //   update 其它   → 老语义,累加 current + update
    //
    // 为什么 0 可以当 sentinel:
    //   节点自然累加时只会返回 1(每次模型调用 += 1),永远不会显式 return 0。
    //   不传该字段时 update 是 undefined,经过 ?? 兜底变 0... 但此时
    //   严格相等 `update === 0` 是 false(undefined !== 0),所以会走累加分支,
    //   等价于"不传 = 不动"的老行为,向后兼容。
    reducer: (current, update) => {
      if (update === 0) return 0;
      return (current ?? 0) + (update ?? 0);
    },
    default: () => 0,
  }),

  /**
   * 已执行的工具次数。
   *
   * 用法和 modelCallCount 一样,toolNode 完成一次就 += 1。
   * 跟 createAgent 路径里 `toolCallLimitMiddleware` 是同一概念,
   * 只是这里我们手写,所以暴露在 state 里、在 agentNode 里检查"是否超额"。
   *
   * Phase 11 fix — 同 modelCallCount,支持 update === 0 的重置协议。
   */
  toolCallCount: Annotation<number>({
    reducer: (current, update) => {
      if (update === 0) return 0;
      return (current ?? 0) + (update ?? 0);
    },
    default: () => 0,
  }),

  /**
   * 早期对话的浓缩摘要(Phase 11 对话压缩)。
   *
   * # 为什么需要这个字段
   *
   * 长对话场景下,state.messages 会一直增长。每次模型调用都把全部 messages
   * 喂给 DeepSeek,会有两个问题:
   *   1. token 成本随对话长度线性飙升
   *   2. 超出模型上下文窗口直接报错
   *
   * 压缩思路:跑到一定长度时,启动一个 summarizeNode,
   *   - 用 LLM 把"老消息"浓缩成一段 summary 文本
   *   - 用 `RemoveMessage` 哨兵把那些老 messages 从 state 里删掉
   *   - summary 存到这个字段,后续 agentNode 把它拼成 SystemMessage
   *     塞在每轮模型调用的最前面,模型仍然"知道"早期发生过什么。
   *
   * # 为什么 reducer 是"覆盖式"(不是累加 / 追加)
   *
   * 每次 summarizeNode 跑完都生成一份**完整**的新 summary
   * (它会把"旧 summary + 新消息"合并成新的"统一 summary"),
   * 所以新值直接替换旧值就行,不需要拼接。
   *
   * # 默认值 ""
   *
   * 选空串而不是 undefined / null,好处是 agentNode 里判断很自然:
   *   if (state.summary) { ... 拼成 SystemMessage ... }
   * 不需要写一堆 ?? 兜底。
   *
   * # 向后兼容
   *
   * 老 thread 的 checkpoint 里没有这个 channel。LangGraph 反序列化时
   * 找不到的 channel 会用 default() 初始化,等价于"老 thread 默认无 summary"。
   * 所以这次改动**对老对话完全无感**,不会因为 schema 不匹配报错。
   */
  summary: Annotation<string>({
    reducer: (_current, update) => update ?? "",
    default: () => "",
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
