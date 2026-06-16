import { prisma } from "../db/prisma";
import { ensureUser } from "../db/threadsRepository";
import type { ThreadMessage } from "../db/threadsRepository";
import { extractMemories, runMemoryWriteForThread } from "./memoryWriter";
import { listMemories } from "./memoryStore";

/**
 * Phase 12 #4 — Memory Writer 验证脚本。
 *
 * 两种用法:
 *
 *   1. 默认:对一段内置的样例对话跑"提炼"(只调 LLM,不写库),看提炼质量
 *        npm run memory:write:debug
 *
 *   2. --thread=<id> --user=<id>:对一个真实对话跑完整"提炼 + 去重入库",
 *      再列出该用户入库后的记忆
 *        npm run memory:write:debug -- --thread=<threadId> --user=<userId>
 *
 * 需要 DeepSeek(提炼调 LLM)+ Ollama(入库算 embedding)在跑。
 */

const SAMPLE_CONVERSATION: ThreadMessage[] = [
  { role: "user", content: "你好,我叫李雷,最近在自学 SwiftUI 做 iOS app" },
  { role: "assistant", content: "你好李雷!很高兴帮你学 SwiftUI。想从哪里开始?" },
  { role: "user", content: "我习惯先看代码例子再看文字解释。先给我讲讲 @State 吧" },
  {
    role: "assistant",
    content: "没问题。@State 是一个属性包装器,用来在视图里声明可变的私有状态……",
  },
];

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.thread) {
    // 完整流程:对真实对话提炼 + 去重入库
    const userId = flags.user || "debug-user";
    await ensureUser(userId);
    console.log(`[WriterDebug] 对 thread=${flags.thread} user=${userId} 跑完整写入流程…`);
    const result = await runMemoryWriteForThread({
      requestId: "writer-debug",
      userId,
      threadId: flags.thread,
    });
    console.log(`[WriterDebug] ✅ inserted=${result.inserted} updated=${result.updated}`);
    console.log("");
    console.log("[WriterDebug] 该用户当前记忆:");
    const memories = await listMemories({ userId });
    for (const m of memories) {
      console.log(`    (${m.kind}) ${m.content}`);
    }
    return;
  }

  // 默认:只提炼样例对话,不写库
  console.log("[WriterDebug] 对内置样例对话跑提炼(不写库)…");
  console.log("");
  for (const m of SAMPLE_CONVERSATION) {
    console.log(`    ${m.role === "user" ? "用户" : "助手"}: ${m.content}`);
  }
  console.log("");
  const extracted = await extractMemories(SAMPLE_CONVERSATION);
  console.log("[WriterDebug] 提炼结果:");
  console.log("    semantic   :", JSON.stringify(extracted.semantic, null, 0));
  console.log("    episodic   :", JSON.stringify(extracted.episodic, null, 0));
  console.log("    procedural :", JSON.stringify(extracted.procedural, null, 0));
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const token of argv) {
    if (token.startsWith("--")) {
      const [key, ...rest] = token.slice(2).split("=");
      flags[key] = rest.join("=") || "true";
    }
  }
  return flags;
}

main()
  .catch((error) => {
    console.error("[WriterDebug] ❌ 失败:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
