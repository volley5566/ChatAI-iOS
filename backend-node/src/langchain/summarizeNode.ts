import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  isHumanMessage,
  RemoveMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { logAgentError, logAgentInfo } from "../agent/agentObservability";
import type { AgentStateType, AgentStateUpdate } from "./agentGraphState";
import { createLangChainChatModel } from "./chatModel";
import { messageContentToString } from "./chatPrompt";

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/summarizeNode.ts — Phase 11 对话压缩节点
 * ═══════════════════════════════════════════════════════════════════
 *
 * # 这个节点要解决的问题
 *
 *   多轮对话久了 → state.messages 越来越长 → 每次模型调用都把全部 messages
 *   喂给 DeepSeek → token 成本随对话长度线性飙升 + 上下文窗口爆炸。
 *
 *   解决:跑到一定长度就让 LLM 把"较老的消息"摘要成一段 summary,
 *   原始消息用 RemoveMessage 哨兵从 state 里干掉。后续 agentNode 把
 *   summary 拼成 SystemMessage 塞到最前面,模型仍然"知道"早期发生过什么。
 *
 * # 核心机制:LangGraph 的 RemoveMessage 哨兵
 *
 *   节点返回的 messages 数组里如果含有 RemoveMessage({id: "xxx"}),
 *   messagesStateReducer 会把 state.messages 里 id 匹配的那条**真正删掉**。
 *   这是 LangGraph 官方支持的"消息删除"协议。
 *
 *   注意 RemoveMessage 不是普通消息,它是个"指令":
 *     - reducer 处理完后,这条 RemoveMessage 自己也不会留在 state 里
 *     - 模型永远看不到 RemoveMessage
 *
 * # 怎么决定"哪些消息要压缩"
 *
 *   策略: 保留"最近 K 个用户回合"(K 默认 3),其余全部压掉。
 *
 *   关键技巧 — **从 HumanMessage 边界切**,不从中间随便切。
 *   原因:模型的 tool_calls(AIMessage) 和工具结果(ToolMessage)是"成对"的。
 *   如果切割位置落在 AI 的 tool_calls 和对应 ToolMessage 之间,模型会
 *   看到一条"无来源"的 ToolMessage,直接报 invalid_request_error。
 *   按 HumanMessage 边界切就天然保证每个对话回合的工具序列是完整的。
 *
 * # 迭代式摘要
 *
 *   如果 state.summary 已经有内容(说明之前压缩过一次),这次摘要时把
 *   旧 summary 也喂给 LLM,要求"基于旧摘要 + 这次新压缩的对话,生成一份
 *   完整的新摘要"。这样长对话连续压缩,语义不会丢。
 *
 *   等价于 git rebase 时的 squash — 多次 squash 出来的还是一份完整提交。
 */

// ─── 配置 ──────────────────────────────────────────────────────

/**
 * 默认保留最近多少个"用户回合"不压缩。
 *
 * 一个"回合"= 一条 HumanMessage 加上它后面的所有 AI / Tool 消息直到下一条 HumanMessage。
 * keepLastTurns=3 表示永远保留最近 3 轮完整对话,只压缩更早的。
 *
 * 选 3 的原因:
 *   - 太小(1-2) → 模型很快失去"我们刚在聊什么"的紧密上下文
 *   - 太大(>5)  → 失去压缩意义
 *   - 3 是 LangGraph 官方 how-to 的常见示例值
 */
const DEFAULT_KEEP_LAST_TURNS = 3;

/**
 * 喂给摘要 LLM 的 system prompt。
 *
 * 写得很严格,因为这次的 LLM 调用对成本敏感:
 *   - 直接输出摘要,不要客套话(节省 output token)
 *   - 控制 200 字以内(后续每轮模型调用都要带这段,越短越省)
 *   - 第三人称叙述 + 抓"目标 / 关键事实 / 已生成内容",不复述对话
 */
const SUMMARIZATION_SYSTEM_PROMPT = `你是一个对话摘要助手。请把给定的对话压缩成不超过 200 个中文字符的摘要。

要求:
- 保留用户的核心目标和当前焦点(在学什么、关心什么)
- 保留 AI 已给过的关键事实、结论、生成过的题目编号或答案要点
- 不要复述具体语句,只保留对后续对话仍有用的信息
- 用第三人称叙述(例如 "用户想学 X,AI 已解释了 Y 和 Z...")
- 直接输出摘要正文,不要写"好的"/"以下是摘要"之类的客套话`;

// ─── 内部 helper ───────────────────────────────────────────────

/**
 * 决定从哪个下标开始保留 messages(其余的全部压缩)。
 *
 * # 算法
 *   1. 收集所有 HumanMessage 的下标
 *   2. 想保留最近 K 个回合 → 切点 = 倒数第 K 个 HumanMessage 的下标
 *   3. 如果总回合数 ≤ K,无需压缩,返回 messages.length(=啥都不压)
 *
 * # 为什么从 HumanMessage 边界切
 *   tool_calls(在 AIMessage)和对应的 ToolMessage 是成对的。
 *   不能让切点落在它们中间,否则模型会看到无主的 ToolMessage 报错。
 *   每个新回合一定从 HumanMessage 开始,从这里切 100% 安全。
 *
 * @returns 保留区间起点下标(切点),0 表示全压缩,messages.length 表示全保留
 */
function pickSafeCutIndex(
  messages: BaseMessage[],
  keepLastTurns: number
): number {
  const humanIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (isHumanMessage(messages[i])) {
      humanIndices.push(i);
    }
  }

  // 回合数还没攒够 → 不压缩
  if (humanIndices.length <= keepLastTurns) {
    return messages.length;
  }

  // 例:有 5 个 HumanMessage,想保留最后 3 个回合 → 从第 humanIndices[5-3]=humanIndices[2] 开始保留
  return humanIndices[humanIndices.length - keepLastTurns];
}

/**
 * 把一组 BaseMessage 渲染成纯文本对话,塞进 prompt 给摘要 LLM 阅读。
 *
 * 格式简单:每条消息 "[角色] 内容",中间空行分隔,方便 LLM 解析。
 * ToolMessage 的 content 通常是 JSON,直接保留即可(摘要 LLM 能识别)。
 */
function renderMessagesAsConversation(messages: BaseMessage[]): string {
  return messages
    .map((message) => {
      const role = message.getType(); // "human" | "ai" | "tool" | "system" | "remove"
      const text = messageContentToString(message.content);

      // AIMessage 如果带 tool_calls,把工具调用也展示出来,
      // 不然摘要 LLM 不知道"AI 这条做了什么动作"
      if (message instanceof AIMessage && message.tool_calls?.length) {
        const toolCallsBrief = message.tool_calls
          .map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`)
          .join(", ");
        return `[${role}] ${text || "(no text)"}\n  → tool_calls: ${toolCallsBrief}`;
      }

      return `[${role}] ${text}`;
    })
    .join("\n\n");
}

/**
 * 构造给摘要 LLM 的 user prompt。
 *
 * 两种形态:
 *   1. 无旧 summary  → "请摘要下面这段对话"
 *   2. 有旧 summary  → "下面是之前对话的摘要 + 这次要追加压缩的对话,请合并成一份新摘要"
 *
 * 第 2 种形态保证迭代压缩不丢早期信息。
 */
function buildSummarizationPrompt(options: {
  existingSummary: string;
  conversationText: string;
}): string {
  if (options.existingSummary) {
    return `下面是已有的对话摘要 + 这次要追加压缩的对话片段。请合并生成一份完整的新摘要,保持 200 字以内。

【已有摘要】
${options.existingSummary}

【要追加压缩的对话】
${options.conversationText}

请输出合并后的新摘要正文:`;
  }

  return `请摘要下面这段对话:

${options.conversationText}

请输出摘要正文:`;
}

// ─── 节点工厂 ──────────────────────────────────────────────────

/**
 * 创建 summarizeNode 工厂。
 *
 * # 工厂模式
 *   跟 agentNode / toolNode 一致:外层收依赖(requestId / 配置),
 *   返回真正的 `(state) => Partial<state>` 节点函数。
 *
 * # 单例 model
 *   把 ChatDeepSeek 实例缓存在闭包里。摘要不需要 streaming,
 *   非流式更便宜也更简单。
 */
export function createSummarizeNode(options: {
  requestId: string;
  /** 保留最近多少个用户回合不压缩,默认 3 */
  keepLastTurns?: number;
}) {
  const keepLastTurns = options.keepLastTurns ?? DEFAULT_KEEP_LAST_TURNS;

  // 摘要不需要 tool_calls / streaming,所以不 bindTools 也不开 streaming
  const summarizeModel = createLangChainChatModel({
    streaming: false,
    disableThinking: true,
  });

  return async function summarizeNode(
    state: AgentStateType
  ): Promise<AgentStateUpdate> {
    const cutIndex = pickSafeCutIndex(state.messages, keepLastTurns);

    // 没东西要压缩(回合数还没攒够,或者已经是空对话)→ 无操作返回
    if (cutIndex <= 0 || cutIndex >= state.messages.length) {
      logAgentInfo(options.requestId, "summarize_node", "skipped_no_op", {
        totalMessages: state.messages.length,
        cutIndex,
        keepLastTurns,
      });
      return {};
    }

    const messagesToCompress = state.messages.slice(0, cutIndex);

    // 防御:消息没 id 就没法用 RemoveMessage 删除,过滤掉并记日志
    const removableMessages = messagesToCompress.filter(
      (m): m is BaseMessage & { id: string } => typeof m.id === "string" && m.id.length > 0
    );

    if (removableMessages.length === 0) {
      logAgentError(
        options.requestId,
        "summarize_node",
        "no_messages_have_ids",
        new Error("all messages-to-compress missing id; cannot use RemoveMessage"),
        { totalMessages: state.messages.length, cutIndex }
      );
      return {};
    }

    logAgentInfo(options.requestId, "summarize_node", "started", {
      totalMessages: state.messages.length,
      cutIndex,
      keepLastTurns,
      messagesToCompress: removableMessages.length,
      hasExistingSummary: Boolean(state.summary),
    });

    const startedAt = Date.now();
    const conversationText = renderMessagesAsConversation(messagesToCompress);

    let newSummary = "";
    try {
      const response = await summarizeModel.invoke([
        new SystemMessage(SUMMARIZATION_SYSTEM_PROMPT),
        new HumanMessage(
          buildSummarizationPrompt({
            existingSummary: state.summary,
            conversationText,
          })
        ),
      ]);
      newSummary = messageContentToString(response.content).trim();
    } catch (error) {
      // LLM 调用失败 → 不删消息也不更新 summary,本轮当无事发生
      // 下次 cutIndex 还会触发,自然重试
      logAgentError(options.requestId, "summarize_node", "llm_call_failed", error, {
        durationMs: Date.now() - startedAt,
      });
      return {};
    }

    if (!newSummary) {
      logAgentError(
        options.requestId,
        "summarize_node",
        "llm_returned_empty",
        new Error("summarization LLM returned empty content"),
        { durationMs: Date.now() - startedAt }
      );
      return {};
    }

    logAgentInfo(options.requestId, "summarize_node", "completed", {
      durationMs: Date.now() - startedAt,
      removedCount: removableMessages.length,
      summaryCharCount: newSummary.length,
    });

    // 返回 partial state 更新:
    //   - summary 覆盖式更新
    //   - messages 这里全是 RemoveMessage,messagesStateReducer 会按 id 删除
    return {
      summary: newSummary,
      messages: removableMessages.map(
        (m) => new RemoveMessage({ id: m.id })
      ),
    };
  };
}

// ─── 调试用 standalone 入口 ───────────────────────────────────

/**
 * 不依赖 LangGraph 运行时,直接跑一次节点函数看输出。
 *
 * 给 `npm run summarize:debug` 用。给的 messages 如果没 id,自动补 id
 * (真实运行时 LangGraph reducer 会自动补,这里手工补一下方便测试)。
 *
 * 返回值: { summary, removedIds } —— 故意不返回完整 state,因为 RemoveMessage
 * 在节点返回值里就是"待删除的指令",看 id 列表就够确认逻辑了。
 */
export async function runSummarizeStandalone(options: {
  messages: BaseMessage[];
  existingSummary?: string;
  keepLastTurns?: number;
}): Promise<{ summary: string; removedIds: string[] }> {
  const messagesWithIds = options.messages.map((m, idx) => {
    if (m.id) return m;
    // BaseMessage 的 id 是 writable string | undefined,直接赋值即可
    (m as { id?: string }).id = `debug-msg-${idx}`;
    return m;
  });

  const node = createSummarizeNode({
    requestId: "summarize-debug",
    keepLastTurns: options.keepLastTurns,
  });

  const update = await node({
    messages: messagesWithIds,
    modelCallCount: 0,
    toolCallCount: 0,
    summary: options.existingSummary ?? "",
  });

  const removedIds = (update.messages ?? [])
    .filter((m): m is RemoveMessage => m instanceof RemoveMessage)
    .map((m) => m.id);

  return {
    summary: update.summary ?? "",
    removedIds,
  };
}
