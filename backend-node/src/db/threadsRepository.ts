import {
  AIMessage,
  HumanMessage,
  isAIMessage,
  isHumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { prisma } from "./prisma";
import { getSqliteCheckpointer } from "./sqliteCheckpointer";
import { messageContentToString } from "../langchain/chatPrompt";

/**
 * ═══════════════════════════════════════════════════════════════════
 * db/threadsRepository.ts — 对话(Thread)业务封装层
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   server.ts(thread CRUD 路由) → 这个文件 →
 *   Prisma(threads 表元信息) + checkpointer(checkpoints/writes 状态快照)
 *
 * # 为什么单独封装一层
 *   把"对话相关的数据操作"集中起来,屏蔽两层细节:
 *     - Prisma   → 操作 threads 表(id / title / createdAt / updatedAt)
 *     - 检查点    → 操作 checkpoints / writes 表(state 快照)
 *
 *   server.ts 只调这一层,不关心数据从哪儿来。后续换数据库(SQLite → Postgres)
 *   或换 checkpointer 实现,改这一层就行,业务路由不动。
 */

/**
 * 给 iOS 端展示的"对话元信息"。
 *
 * 注意字段命名:都是 snake_case—— iOS 端用 JSONDecoder
 * 配 .convertFromSnakeCase 自动转 Swift 驼峰。
 * 这是 HTTP 协议层的约定,和 ChatRequestBody 风格统一。
 */
export type ThreadSummary = {
  id: string;
  title: string | null;
  created_at: string; // ISO 8601 字符串
  updated_at: string;
};

/**
 * 给 iOS 端展示的"对话内一条消息"。
 *
 * 只暴露给用户看的两类:
 *   - user:用户消息(HumanMessage)
 *   - assistant:模型最终回答(AIMessage 且 content 非空)
 *
 * 内部消息(tool_calls 的 AIMessage、ToolMessage)**不暴露**——
 * 那些是 Agent 内部"思考过程",iOS 用户看不懂也不需要看。
 */
export type ThreadMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Phase 11 #5 — 一个 thread 的对话历史 + 早期对话摘要。
 *
 * # 为什么把 summary 一起返回
 *
 * Phase 11 之后 state.messages 可能被 summarizeNode 真删掉了一部分,
 * 那部分内容的"大意"留在 state.summary 里。iOS 拉历史时如果只拿 messages,
 * 用户会困惑"我明明聊了 20 轮怎么只剩 6 条?"
 *
 * 把 summary 一起返回,iOS 就能在消息列表顶部展示"📋 早期 N 条对话已压缩"
 * 的提示条,让用户知道"老消息没丢,只是浓缩了"。
 */
export type ThreadMessagesPayload = {
  messages: ThreadMessage[];
  /** 早期对话的浓缩摘要;空串表示没压缩过 */
  summary: string;
};

/**
 * Phase 12 — 确保某个 userId 在 users 表里存在(不存在就建一行)。
 *
 * # 为什么需要这一步
 *   Thread.userId / Memory.userId 都是指向 users 表的外键。
 *   外键约束要求"被指向的那行必须先存在",否则插入会报 FK 违约。
 *   iOS 端的 userId 是本地生成的匿名 UUID,后端第一次见到时表里还没有,
 *   所以在关联对话/记忆之前,先 upsert 兜底建好这个用户。
 *
 * # 为什么用 upsert 而不是 create
 *   绝大多数请求里这个用户早就存在了,upsert 的语义正是
 *   "有就什么都不做(update {} 只刷 updatedAt),没有才建",幂等、并发安全。
 *
 * 传空 / undefined 直接跳过——匿名(无 userId)请求依旧能跑,向后兼容。
 */
export async function ensureUser(userId?: string): Promise<void> {
  const id = userId?.trim();
  if (!id) {
    return;
  }
  await prisma.user.upsert({
    where: { id },
    create: { id },
    update: {}, // 已存在:空更新,仅触发 @updatedAt
  });
}

/**
 * 创建新对话。
 *
 * 此时只在 Prisma threads 表里插一行——checkpointer 那边还没任何快照,
 * 等用户发第一条消息触发 /api/agent/stream 时,LangGraph 才会写第一条 checkpoint。
 *
 * Phase 9 #7 加了可选的 id 参数:
 *   - 不传 → Prisma 自动生成 UUID(老行为)
 *   - 传 → 用调用方指定的 id(Time-travel fork 时需要先在 LangGraph
 *          那边算好新 thread_id,再用同一个 id 在 Prisma 这边建行)
 *
 * Phase 12 加了可选的 userId 参数:
 *   - 传了 → 先 ensureUser 兜底,再把对话挂到这个用户名下
 *   - 不传 → userId 留空(匿名对话),向后兼容
 */
export async function createThread(options: {
  id?: string;
  title?: string;
  userId?: string;
}): Promise<ThreadSummary> {
  const userId = options.userId?.trim() || undefined;
  await ensureUser(userId);

  const thread = await prisma.thread.create({
    data: {
      ...(options.id ? { id: options.id } : {}),
      title: options.title?.trim() || null,
      ...(userId ? { userId } : {}),
      // id / createdAt / updatedAt 默认让 Prisma 自动填(见 schema.prisma)
    },
  });

  return toSummary(thread);
}

/**
 * 列出所有对话,按"最近活跃"倒序。
 *
 * 排序用 updatedAt 而不是 createdAt:
 *   - 用户刚发完消息的对话排最上面
 *   - 这就是 ChatGPT 左侧列表的视觉顺序
 *
 * 性能:目前没分页,简单 findMany。
 * 如果以后对话超过几百条要考虑加 cursor 分页,
 * 学习项目阶段不优化。
 */
export async function listThreads(): Promise<ThreadSummary[]> {
  const threads = await prisma.thread.findMany({
    orderBy: { updatedAt: "desc" },
  });

  return threads.map(toSummary);
}

/**
 * 拿到某个对话的所有可展示消息。
 *
 * 这个方法是 Step 5.4 最有意思的部分——
 * 它跨越 Prisma 和 checkpointer 两层数据:
 *
 *   1. 用 checkpointer.getTuple({thread_id}) 拿最新 state 快照
 *   2. 从快照里取 channel_values.messages(就是我们 AgentState 里的 messages 字段)
 *   3. 过滤掉"内部消息"(tool_calls / ToolMessage)
 *   4. 转成 ThreadMessage[] 返回
 *
 * 如果 thread 在 Prisma 表里有,但 checkpointer 里还没有(新建后还没发消息),
 * 返回空数组。
 *
 * 如果 thread 在 Prisma 表里没有,直接返回空数组(让上层决定要不要报 404)。
 */
export async function getThreadMessages(
  threadId: string
): Promise<ThreadMessagesPayload> {
  const checkpointer = getSqliteCheckpointer();

  /**
   * getTuple 是 BaseCheckpointSaver 接口的标准方法。
   * 返回最新的 checkpoint;如果这个 thread_id 从没存过,返回 undefined。
   */
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId },
  });

  if (!tuple) {
    return { messages: [], summary: "" };
  }

  /**
   * checkpoint.channel_values 是个对象,key 是 state 字段名,value 是当前值。
   * 我们 state schema 里有 messages / modelCallCount / toolCallCount / summary。
   *
   * 类型断言成具体类型是因为 checkpoint 序列化时类型信息被丢失了,
   * channel_values 实际类型是 Record<string, unknown>。
   */
  const channelValues = tuple.checkpoint.channel_values as Record<string, unknown>;
  const messages = (channelValues?.messages as BaseMessage[]) || [];

  // Phase 11 #5 — 同时取 summary。
  // 老对话(Phase 11 之前的 checkpoint)没有 summary 这个 channel,
  // 这里读出来会是 undefined,用 "" 兜底 → iOS 看到空串就不显示压缩提示。
  const summary = (channelValues?.summary as string | undefined) ?? "";

  return {
    messages: messagesToThreadMessages(messages),
    summary,
  };
}

/**
 * 把 LangChain BaseMessage[] 过滤+转换成 iOS 端能消费的格式。
 *
 * 过滤规则:
 *   - HumanMessage → 保留,role = "user"
 *   - AIMessage 且 content 非空 → 保留,role = "assistant"
 *   - AIMessage 但 content 空(只有 tool_calls)→ 跳过(这是 Agent 内部思考)
 *   - ToolMessage / SystemMessage → 跳过
 */
function messagesToThreadMessages(messages: BaseMessage[]): ThreadMessage[] {
  const result: ThreadMessage[] = [];

  for (const message of messages) {
    if (isHumanMessage(message)) {
      const text = messageContentToString(message.content);
      if (text.trim()) {
        result.push({ role: "user", content: text });
      }
    } else if (isAIMessage(message)) {
      const text = messageContentToString(message.content);
      /**
       * 过滤掉"空 content 的 AIMessage"——它通常只是模型决定调工具的中间消息。
       * 空消息显示给用户毫无意义。
       */
      if (text.trim()) {
        result.push({ role: "assistant", content: text });
      }
    }
    /**
     * 其他类型(ToolMessage、SystemMessage、FunctionMessage)都跳过。
     * 它们要么是 Agent 内部数据,要么是注入的系统提示,iOS 用户不需要看到。
     */
  }

  return result;
}

/**
 * 删除一个对话——**双向删**:
 *   1. checkpointer 删该 thread_id 的所有 checkpoints + writes
 *   2. Prisma 删 threads 表里的那一行
 *
 * 顺序很重要:先删 checkpointer(那是大头数据),再删 Prisma 元信息。
 * 万一中间崩了:
 *   - checkpointer 删了但 Prisma 没删 → 列表里能看到孤儿 thread,刷新一下就能用同 id 复发请求(因为 stream handler 会 upsert)
 *   - 反过来更糟:Prisma 删了但 checkpoints 还在 → checkpoints 表里有"找不到 owner 的数据",占空间
 *
 * 学习项目暂不上事务/补偿——单机 SQLite + 操作极快,失败概率几乎为 0。
 */
export async function deleteThread(threadId: string): Promise<void> {
  const checkpointer = getSqliteCheckpointer();

  /**
   * SqliteSaver.deleteThread(threadId) 是 LangGraph 提供的现成方法,
   * 一条 SQL 就把这个 thread 所有 checkpoint 删了。
   */
  await checkpointer.deleteThread(threadId);

  /**
   * Prisma 的 delete 在记录不存在时会抛 P2025 错误,
   * 用 deleteMany 更宽容——不存在就静默跳过。
   */
  await prisma.thread.deleteMany({ where: { id: threadId } });
}

/**
 * "Touch" 一个 thread——确保它存在,并把 updatedAt 刷新到当前时间。
 *
 * 这是 /api/agent/stream handler 在收到带 threadId 的请求时调的——
 * 既保证"用户没 POST /api/threads 也能用同样的 threadId 跑通",
 * 又让 thread 列表按"最近活跃"排序。
 *
 * upsert + update {} 是 Prisma 触发 @updatedAt 的标准技巧:
 *   - 找不到这个 id 就按 create 数据创建
 *   - 找到了就执行 update {}(空更新),触发 @updatedAt 刷
 *
 * Phase 12:可选 userId。
 *   - 传了 → 先 ensureUser,再把 userId 写进对话(create 和 update 都写)。
 *           对 update 也写 userId 的好处:Phase 12 之前建的老对话(userId 为空)
 *           会在用户下次发消息时被自动"回填"归属,无需单独的数据迁移脚本。
 *   - 不传 → 退回老行为(空更新只刷 updatedAt),匿名请求照常工作。
 */
export async function touchThread(
  threadId: string,
  userId?: string
): Promise<void> {
  const ownerId = userId?.trim() || undefined;
  await ensureUser(ownerId);

  await prisma.thread.upsert({
    where: { id: threadId },
    create: { id: threadId, ...(ownerId ? { userId: ownerId } : {}) },
    update: ownerId ? { userId: ownerId } : {}, // 空更新仍触发 updatedAt 刷
  });
}

/**
 * 内部辅助:Prisma 返回的 Thread record → 暴露给 iOS 的 ThreadSummary。
 *
 * 主要做两件事:
 *   - DateTime → ISO 8601 字符串(JSON 友好)
 *   - 字段名转 snake_case
 */
function toSummary(thread: {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    created_at: thread.createdAt.toISOString(),
    updated_at: thread.updatedAt.toISOString(),
  };
}
