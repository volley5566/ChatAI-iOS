import { PrismaClient } from "@prisma/client";

/**
 * Phase 5 — Prisma Client 验证脚本。
 *
 * 跑法:
 *   npm run prisma:debug
 *
 * 这个脚本的目的:
 *   - 确认 Prisma Client 真的能连上 SQLite
 *   - 确认 Thread 表的 CRUD 都能用
 *   - 作为最小可工作示例,后面写真业务代码可以参考
 *
 * 跑完留下的 Thread 会被脚本自己删掉,数据库恢复干净。
 *
 * # 重要概念:PrismaClient
 *
 * `new PrismaClient()` 是 Prisma 自动生成的"数据库客户端实例"。
 * 它内部:
 *   - 读 .env 里的 DATABASE_URL
 *   - 连接 SQLite 文件
 *   - 提供 prisma.thread.findMany() 这种类型安全的查询 API
 *
 * 注意:**生产代码里不要每次创建新 PrismaClient**——它会重复打开连接。
 * 后续会写一个 `db/prisma.ts` 单例,所有业务代码共享一个实例。
 * 这个 debug 脚本是"独立运行 + 跑完就退",所以自己 new 一个无所谓。
 */

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log("[PrismaDebug] 1. 连接数据库...");
    // PrismaClient 是 lazy connect,第一次 query 才真正连接。
    // 用 $connect() 主动触发,如果连不上能立刻看到错误。
    await prisma.$connect();
    console.log("[PrismaDebug]    ✅ 已连接");

    console.log("");
    console.log("[PrismaDebug] 2. 创建一条 Thread...");
    const created = await prisma.thread.create({
      data: {
        title: "测试对话 - Phase 5.1 验证",
      },
    });
    console.log("[PrismaDebug]    ✅ 已创建:", created);

    console.log("");
    console.log("[PrismaDebug] 3. 列出所有 Thread(应该包含刚创建的那条)...");
    const all = await prisma.thread.findMany({
      orderBy: { createdAt: "desc" },
    });
    console.log("[PrismaDebug]    ✅ 共", all.length, "条:");
    for (const t of all) {
      console.log("       -", t.id, "|", t.title, "|", t.createdAt);
    }

    console.log("");
    console.log("[PrismaDebug] 4. 删除刚创建的那条(清理测试数据)...");
    await prisma.thread.delete({ where: { id: created.id } });
    console.log("[PrismaDebug]    ✅ 已删除");

    console.log("");
    console.log("[PrismaDebug] 5. 再列一遍(应该恢复到原状态)...");
    const after = await prisma.thread.findMany();
    console.log("[PrismaDebug]    ✅ 剩余", after.length, "条");

    console.log("");
    console.log("[PrismaDebug] 🎉 Prisma + SQLite 全链路验证通过!");
  } catch (error) {
    console.error("[PrismaDebug] ❌ 验证失败:", error);
    process.exitCode = 1;
  } finally {
    // ⚠️ 一定要 disconnect,否则进程会挂住不退出
    await prisma.$disconnect();
  }
}

void main();
