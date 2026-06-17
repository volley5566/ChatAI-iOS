/**
 * Phase 12 #6 — 跨对话长期记忆的端到端回归测试(独立脚本)。
 *
 * ──────────────────────────────────────────────────────────────────
 * 为什么不塞进 runEval.ts 的 21 条 QA 数据集?
 *   那套数据集是"单轮冷启动问答"(每条 case 独立、无 userId、无持久化)。
 *   跨对话记忆天生需要"先有一条记忆 → 换个新对话还能用上",形态完全不同,
 *   硬塞进去要给 EvalCase 加 userId/seedMemory 字段、改 runAgent、加 evaluator,
 *   反而把那套清爽的 QA 框架搞乱。所以单独写一个自包含的断言脚本。
 *
 * 它测什么(把之前手动验过的 e2e 固化成可复跑的回归守卫):
 *   1. 给一个测试用户播种一条"只有记忆里才有"的事实
 *   2. 在一个全新 thread 里问相关问题(走和线上完全相同的 Agent 代码)
 *   3. 断言回答里出现了那条记忆的关键信息 → 证明"跨对话召回"没坏
 *   4. 不管成败都清理掉测试数据
 *
 * 跑法(必须开 recall 开关,且 Ollama + DeepSeek 在跑):
 *   npm run memory:eval
 * ──────────────────────────────────────────────────────────────────
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/prisma";
import { ensureUser, deleteThread } from "../src/db/threadsRepository";
import { clearUserMemories, putMemory } from "../src/memory/memoryStore";
import { runLangChainAgentStream } from "../src/agent/agentRunner";
import { memoryRecallEnabled } from "../src/config/env";

const TEST_USER = `eval-memory-${randomUUID()}`;
// 编一个模型绝无可能"猜中"的事实(随机姓名 + 冷门技术),确保答对只能靠召回。
const SECRET_NAME = "古丽娜扎尔·艾买提";
const SECRET_TOPIC = "Zig 编程语言";

async function main(): Promise<void> {
  console.log("[MemoryEval] Phase 12 跨对话记忆回归测试");

  if (!memoryRecallEnabled) {
    console.error(
      "[MemoryEval] ❌ MEMORY_RECALL_ENABLED 未开启。请用 `npm run memory:eval`(已内置该环境变量)运行。"
    );
    process.exitCode = 1;
    return;
  }

  const threadId = randomUUID();
  let passed = false;

  try {
    // 1. 播种记忆(干净起步:先清掉该用户已有记忆)
    await ensureUser(TEST_USER);
    await clearUserMemories(TEST_USER);
    await putMemory({
      userId: TEST_USER,
      kind: "semantic",
      content: `用户的名字叫${SECRET_NAME},正在学习${SECRET_TOPIC}`,
    });
    console.log(`[MemoryEval] 已播种记忆:名字=${SECRET_NAME} / 方向=${SECRET_TOPIC}`);

    // 2. 在全新 thread 里提问(和线上同一条 Agent 代码路径)
    const result = await runLangChainAgentStream({
      requestId: `memeval-${randomUUID()}`,
      message: "你还记得我叫什么名字、在学什么吗?",
      systemPrompt: undefined,
      history: [],
      threadId,
      userId: TEST_USER,
    });

    const answer = result.outputText;
    console.log(`[MemoryEval] AI 回答:${answer.slice(0, 160)}`);

    // 3. 断言:回答里要同时出现名字和学习方向
    const hitName = answer.includes(SECRET_NAME);
    const hitTopic = answer.includes("Zig");
    passed = hitName && hitTopic;

    console.log(
      `[MemoryEval] 断言:名字命中=${hitName} 方向命中=${hitTopic} → ${passed ? "PASS ✅" : "FAIL ❌"}`
    );
  } catch (error) {
    console.error("[MemoryEval] ❌ 运行出错:", error);
  } finally {
    // 4. 清理:记忆 + 用户 + 该 thread 的 checkpoint
    try {
      await clearUserMemories(TEST_USER);
      await prisma.user.deleteMany({ where: { id: TEST_USER } });
      await deleteThread(threadId);
    } catch (cleanupError) {
      console.warn("[MemoryEval] 清理时出错(可忽略):", cleanupError);
    }
    await prisma.$disconnect();
  }

  if (!passed) {
    process.exitCode = 1;
  }
}

void main();
