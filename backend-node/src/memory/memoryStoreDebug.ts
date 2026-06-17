import { prisma } from "../db/prisma";
import { ensureUser } from "../db/threadsRepository";
import {
  deleteMemory,
  listMemories,
  putMemory,
  searchMemories,
  type MemoryKind,
} from "./memoryStore";

/**
 * Phase 12 #2 — Memory Store 验证脚本(不启动后端、不调 DeepSeek)。
 *
 * 跑法:
 *   npm run memory:debug -- put "我在学 SwiftUI"
 *   npm run memory:debug -- put --kind=procedural "喜欢先看代码再看解释"
 *   npm run memory:debug -- search "我在学什么编程"
 *   npm run memory:debug -- search --kind=semantic --topk=3 "用户的偏好"
 *   npm run memory:debug -- list
 *   npm run memory:debug -- delete <memoryId>
 *
 * 公共可选 flag:
 *   --user=<id>   指定用户(默认 "debug-user")
 *   --kind=<k>    semantic | episodic | procedural(put 默认 semantic)
 *   --topk=<n>    search 取前几条(默认 5)
 *
 * 它验证的是:embedding 能算出来、向量能存进 BLOB、cosine 检索能按语义排序。
 * 这一步需要 Ollama 在跑(默认 EMBEDDINGS_PROVIDER=ollama);
 * 没装 Ollama 可临时用 EMBEDDINGS_PROVIDER=local-keyword 跑通链路。
 */

const DEFAULT_USER = "debug-user";

async function main() {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];

  const userId = flags.user || DEFAULT_USER;
  const kind = (flags.kind as MemoryKind | undefined) ?? "semantic";

  // 记忆挂在用户名下(外键约束),先确保这个调试用户存在。
  await ensureUser(userId);

  switch (command) {
    case "put": {
      const content = positionals.slice(1).join(" ").trim();
      if (!content) {
        console.error('用法: npm run memory:debug -- put [--kind=semantic] "记忆内容"');
        process.exitCode = 1;
        break;
      }
      const record = await putMemory({ userId, kind, content });
      console.log("[MemoryDebug] ✅ 已写入记忆:");
      console.log("    id      :", record.id);
      console.log("    user    :", record.userId);
      console.log("    kind    :", record.kind);
      console.log("    content :", record.content);
      break;
    }

    case "search": {
      const query = positionals.slice(1).join(" ").trim();
      if (!query) {
        console.error('用法: npm run memory:debug -- search [--kind=] [--topk=5] "查询"');
        process.exitCode = 1;
        break;
      }
      const topK = flags.topk ? Number(flags.topk) : 5;
      const hits = await searchMemories({
        userId,
        query,
        kind: flags.kind as MemoryKind | undefined,
        topK,
      });
      console.log(`[MemoryDebug] 🔍 "${query}" 命中 ${hits.length} 条(按相关度降序):`);
      if (hits.length === 0) {
        console.log("    (没有命中。先 put 几条,且确认 Ollama 在跑、embeddingModel 一致)");
      }
      for (const hit of hits) {
        console.log(`    [${hit.score.toFixed(4)}] (${hit.kind}) ${hit.content}`);
      }
      break;
    }

    case "list": {
      const records = await listMemories({
        userId,
        kind: flags.kind as MemoryKind | undefined,
      });
      console.log(`[MemoryDebug] 📋 用户 ${userId} 共 ${records.length} 条记忆:`);
      for (const record of records) {
        console.log(
          `    ${record.id} | ${record.kind} | ${record.content} | ${record.updatedAt.toISOString()}`
        );
      }
      break;
    }

    case "delete": {
      const id = positionals[1];
      if (!id) {
        console.error("用法: npm run memory:debug -- delete <memoryId>");
        process.exitCode = 1;
        break;
      }
      const ok = await deleteMemory(id);
      console.log(ok ? `[MemoryDebug] ✅ 已删除 ${id}` : `[MemoryDebug] ⚠️ 未找到 ${id}`);
      break;
    }

    default:
      console.log("Phase 12 #2 — Memory Store 调试脚本");
      console.log("");
      console.log("子命令:");
      console.log('  put    [--kind=semantic] "内容"     写入一条记忆');
      console.log('  search [--kind=] [--topk=5] "查询"   语义检索');
      console.log("  list   [--kind=]                     列出全部(按时间倒序)");
      console.log("  delete <id>                          删除一条");
      console.log("");
      console.log("公共 flag: --user=<id>(默认 debug-user)");
      break;
  }
}

/**
 * 极简 argv 解析:把 `--key=value` 收成 flags,其余按顺序收成 positionals。
 * 不引第三方库——调试脚本够用就行。
 */
function parseArgs(argv: string[]): {
  positionals: string[];
  flags: Record<string, string>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (const token of argv) {
    if (token.startsWith("--")) {
      const [key, ...rest] = token.slice(2).split("=");
      flags[key] = rest.join("=") || "true";
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

main()
  .catch((error) => {
    console.error("[MemoryDebug] ❌ 失败:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
