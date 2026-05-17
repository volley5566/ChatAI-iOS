import path from "path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

/**
 * Phase 5.2 — LangGraph SqliteSaver 单例工厂。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个文件干两件事:
 *   1. 创建一个共享的 SqliteSaver 实例(整个进程只有一个)
 *   2. 让 agentGraph.ts 编译图时挂上它
 * ─────────────────────────────────────────────────────────────────────
 *
 * # 什么是 SqliteSaver?
 *
 * SqliteSaver 是 LangGraph 提供的"自动存档系统"的 SQLite 实现:
 *   - 实现了 BaseCheckpointSaver 接口
 *   - 内部用 better-sqlite3 操作数据库
 *   - 把图运行时的 state 快照(checkpoint)按 thread_id 存到数据库
 *   - 还有 deleteThread(threadId) 这种业务方法
 *
 * 同一接口的兄弟实现:
 *   - MemorySaver         → 存内存(默认,不持久化,适合临时测试)
 *   - PostgresSaver       → 存 Postgres(生产环境推荐)
 *   - RedisSaver          → 存 Redis
 *
 * 我们这个学习项目选 SQLite:零配置、单文件、易备份。
 *
 *
 * # 为什么用单例?
 *
 * SqliteSaver 内部持有一个 better-sqlite3 Database 连接。
 * 同一个 .db 文件**不能被多个 Database 实例同时打开**(SQLite 文件锁机制)。
 *
 * 所以全进程必须只有 1 个 SqliteSaver。
 * 我们用模块级变量 + lazy init 实现这个单例。
 *
 *
 * # 为什么用绝对路径?
 *
 * 注意 .env 里的 DATABASE_URL="file:./dev.db",这是 **Prisma 的格式**——
 * Prisma 会自动把 "./" 解析为 prisma/schema.prisma 所在目录。
 *
 * 但 SqliteSaver.fromConnString 不懂 Prisma 这套约定,
 * 它就把字符串当成普通文件路径,相对路径会基于"进程的 cwd",
 * 而 cwd 在 dev / debug / 生产里可能不同——很不可靠。
 *
 * 所以这里我们用 `path.resolve(__dirname, ...)` 拼出绝对路径,
 * 不管谁用什么 cwd 启动进程,都指向同一个文件。
 */

/**
 * 数据库文件的绝对路径。
 *
 * __dirname 是当前文件所在目录:
 *   - dev:   .../backend-node/src/db
 *   - build: .../backend-node/dist/db
 *
 * 都往上两层(到 backend-node/ 或 dist/...),
 * 但其实 build 后通常 cwd 仍在 backend-node/,prisma/dev.db 是相对它的。
 *
 * 为了和 Prisma 用同一个文件,这里直接固定写"backend-node/prisma/dev.db"。
 * 计算方式:从当前文件位置往回退到 backend-node 根目录,再拼 prisma/dev.db。
 *
 * 注意如果以后 build 后 dist/ 结构变了,这一行可能要调整。
 */
const databasePath = path.resolve(__dirname, "..", "..", "prisma", "dev.db");

/**
 * 模块级单例。
 * 第一次调用 getSqliteCheckpointer() 时创建,后续复用。
 */
let cachedCheckpointer: SqliteSaver | undefined;

/**
 * 拿到全进程共享的 SqliteSaver 实例。
 *
 * # 调用时机
 *
 * agentGraph.ts 在每次请求构图时调一次:
 *   const graph = builder.compile({ checkpointer: getSqliteCheckpointer() });
 *
 * 注意 .compile() 也是请求级的(图本身是请求级的,见 Phase 4 讲解),
 * 但 SqliteSaver 实例只创建一次,所有请求复用同一个。
 *
 * # 第一次调用做了什么
 *
 * SqliteSaver.fromConnString(path) 内部:
 *   1. new Database(path) —— 打开 SQLite 文件(better-sqlite3)
 *   2. 准备好 prepared statements
 *
 * 注意它**不会自动建表**——表是在第一次写 checkpoint 时,内部 setup() 才会
 * CREATE TABLE IF NOT EXISTS。所以你跑这个函数后看数据库,可能还没有
 * checkpoints / writes 这些表;跑一次带 thread_id 的图调用后才会出现。
 */
export function getSqliteCheckpointer(): SqliteSaver {
  if (!cachedCheckpointer) {
    cachedCheckpointer = SqliteSaver.fromConnString(databasePath);
  }
  return cachedCheckpointer;
}

/**
 * 关闭单例(主要给测试 / 调试脚本用)。
 *
 * 普通业务代码不需要调这个——SqliteSaver 持有的 Database 连接会随进程退出
 * 自动释放。
 *
 * 但 debug 脚本如果想"跑完立刻退出",可以显式调一下,确保数据库连接释放。
 */
export function closeSqliteCheckpointer(): void {
  if (cachedCheckpointer) {
    /**
     * SqliteSaver 没有公开的 close() 方法,但内部的 db 属性是 better-sqlite3 实例,
     * 它有 .close() 方法。
     */
    cachedCheckpointer.db.close();
    cachedCheckpointer = undefined;
  }
}
