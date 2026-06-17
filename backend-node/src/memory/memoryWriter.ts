import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { invokeLangChainChat } from "../langchain/chatModel";
import { memoryWriteDedupThreshold } from "../config/env";
import {
  getThreadMessages,
  type ThreadMessage,
} from "../db/threadsRepository";
import {
  logAgentError,
  logAgentInfo,
} from "../agent/agentObservability";
import {
  MEMORY_KINDS,
  putMemory,
  searchMemories,
  updateMemory,
  type MemoryKind,
} from "./memoryStore";

/**
 * ═══════════════════════════════════════════════════════════════════
 * memory/memoryWriter.ts — 记忆"写入员"(Phase 12 #4)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   server.ts(一轮对话正常结束后)→ scheduleMemoryWrite(fire-and-forget)
 *     → runMemoryWriteForThread → extractMemories(调 LLM)+ 去重入库(memoryStore)
 *
 * # 这一层负责什么
 *   #2 的 memoryStore 只会"存"和"取",不判断"什么值得记"。
 *   memoryWriter 就是那个判断者:对话结束后,让 LLM 看最近几轮对话,
 *   提炼出"关于用户的、以后还用得上的"稳定信息,去重后交给 memoryStore 存。
 *
 * # 三个关键设计决定
 *
 *   1. 只喂"最近几条"对话,不喂整段历史
 *      新事实几乎总是出现在最新一轮(用户刚说"我叫X")。每轮都把整段历史
 *      重新提炼既贵又会反复提炼老内容。喂最近窗口 + 去重,性价比最高。
 *
 *   2. fire-and-forget,绝不阻塞用户
 *      写入要多花一次 LLM 调用(2-5 秒)。它在 SSE 回答发完之后才后台跑,
 *      失败只记日志。用户永远不会因为"记忆没写成"而等待或报错。
 *
 *   3. 朴素去重:相似度超阈值就更新,否则插入
 *      避免同一个事实("用户在学 Rust")被每轮重复存。不做复杂的语义合并,
 *      "用新表述刷新旧那条"已经能解决 90% 的重复问题。
 */

/** LLM 提炼出来的三类记忆(还没入库)。 */
export type ExtractedMemories = {
  semantic: string[];
  episodic: string[];
  procedural: string[];
};

/** 入库结果统计,给日志 / 调试看。 */
export type MemoryWriteResult = {
  inserted: number;
  updated: number;
};

/**
 * 喂给 LLM 的"最近对话"窗口大小。
 * 8 条 ≈ 最近 3-4 个来回,足够覆盖"用户刚刚说的事",又不会太长太贵。
 */
const RECENT_MESSAGES_WINDOW = 8;

/** 每类记忆单次最多提炼几条,防止模型一次吐一大堆噪音。 */
const MAX_ITEMS_PER_KIND = 5;

const EXTRACTION_SYSTEM_PROMPT = `
You extract LONG-TERM MEMORIES about THE USER from a short conversation snippet.
Goal: capture durable info that will help in FUTURE, unrelated conversations.

Output ONLY valid JSON. No Markdown, no code fences, no extra text.

JSON shape (use exactly these keys):
{
  "semantic": ["..."],
  "episodic": ["..."],
  "procedural": ["..."]
}

Categories:
- semantic: stable facts about the user or their world (name, what they are
  learning, goals, background, native language).
- episodic: specific noteworthy past events about the user (e.g. answered a quiz
  on a topic and got it wrong / right).
- procedural: the user's preferences or how they like things done (e.g. prefers
  code examples before explanations, prefers concise answers).

Strict rules:
- ONLY record durable info ABOUT THE USER that is useful later.
- DO NOT record: general knowledge, the assistant's explanations, the specific
  Q&A content of this chat, or one-off transient questions.
- If there is nothing worth remembering, return all empty arrays. Empty is common
  and correct — strongly prefer empty arrays over recording noise.
- Each item: ONE concise statement in Chinese, third person, starting with "用户",
  under 50 characters.
- Deduplicate within your own output.
- Output the JSON only, no reasoning.
`.trim();

// ─── 提炼(纯 LLM 调用,可单独测试) ──────────────────────────

/**
 * 让 LLM 从一段对话里提炼三类记忆。
 *
 * 不碰数据库,只负责"对话 → 结构化记忆候选"。失败 / 解析不出来时返回空,
 * 让上层当成"这轮没什么可记的",不抛错。
 */
export async function extractMemories(
  messages: ThreadMessage[]
): Promise<ExtractedMemories> {
  const empty: ExtractedMemories = {
    semantic: [],
    episodic: [],
    procedural: [],
  };

  if (messages.length === 0) {
    return empty;
  }

  const transcript = messages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
    .join("\n");

  const raw = await invokeLangChainChat([
    new SystemMessage(EXTRACTION_SYSTEM_PROMPT),
    new HumanMessage(`对话片段(最近 ${messages.length} 条):\n${transcript}`),
  ]);

  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return empty;
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      semantic: toStringArray(parsed.semantic),
      episodic: toStringArray(parsed.episodic),
      procedural: toStringArray(parsed.procedural),
    };
  } catch {
    // 解析失败不致命:这轮当作没提炼到。
    return empty;
  }
}

// ─── 提炼 + 去重入库 ──────────────────────────────────────────

/**
 * 一轮对话结束后的完整写入流程:读最近对话 → 提炼 → 去重 → 入库。
 *
 * 去重逻辑:对每条提炼出的记忆,在该用户的同类记忆里搜最相似的一条,
 *   相似度 ≥ memoryWriteDedupThreshold → updateMemory 刷新那条(不新增)
 *   否则                                → putMemory 插入新的
 *
 * 单条入库失败(某次 embedding 超时等)不影响其它条 —— 每条独立 try/catch。
 */
export async function runMemoryWriteForThread(input: {
  requestId: string;
  userId: string;
  threadId: string;
}): Promise<MemoryWriteResult> {
  const { messages } = await getThreadMessages(input.threadId);
  const recent = messages.slice(-RECENT_MESSAGES_WINDOW);

  const extracted = await extractMemories(recent);

  let inserted = 0;
  let updated = 0;

  for (const kind of MEMORY_KINDS) {
    for (const content of extracted[kind]) {
      try {
        // 找该用户同类记忆里最像的一条
        const [mostSimilar] = await searchMemories({
          userId: input.userId,
          query: content,
          kind,
          topK: 1,
          minScore: memoryWriteDedupThreshold,
        });

        if (mostSimilar) {
          // 命中"几乎一样"的旧记忆 → 刷新它,不新增
          await updateMemory(mostSimilar.id, content);
          updated += 1;
        } else {
          await putMemory({
            userId: input.userId,
            kind,
            content,
            sourceThreadId: input.threadId,
          });
          inserted += 1;
        }
      } catch (error) {
        logAgentError(input.requestId, "memory_write", "store_item_failed", error, {
          kind,
        });
      }
    }
  }

  logAgentInfo(input.requestId, "memory_write", "completed", {
    userId: input.userId,
    threadId: input.threadId,
    extracted:
      extracted.semantic.length +
      extracted.episodic.length +
      extracted.procedural.length,
    inserted,
    updated,
  });

  return { inserted, updated };
}

/**
 * fire-and-forget 入口:立刻返回,真正的提炼/入库在下一个事件循环 tick 跑。
 *
 * server.ts 在一轮对话正常结束后(且无 HITL 挂起)调它。用 setImmediate
 * 确保它**在 HTTP 响应彻底处理完之后**才开始,绝不挤占用户请求的资源。
 * 任何异常都在这里兜住,只记日志 —— 写记忆失败永远不该惊动用户。
 */
export function scheduleMemoryWrite(input: {
  requestId: string;
  userId: string;
  threadId: string;
}): void {
  setImmediate(() => {
    runMemoryWriteForThread(input).catch((error) => {
      logAgentError(input.requestId, "memory_write", "failed", error, {
        userId: input.userId,
        threadId: input.threadId,
      });
    });
  });
}

// ─── 内部纯函数 ───────────────────────────────────────────────

/**
 * 从 LLM 输出里抠出首尾 {} 之间的 JSON(模型偶尔会包代码围栏或多写字)。
 * 和 evaluateAnswerGraph 里的同名函数实现一致 —— 重复一份是为了让 memory/
 * 不依赖 langchain/subgraphs/。
 */
function extractJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return raw.slice(start, end + 1);
}

/** 把 unknown 收成"去空白、去空串、限量"的字符串数组。 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS_PER_KIND);
}
