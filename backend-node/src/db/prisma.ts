import { PrismaClient } from "@prisma/client";

/**
 * Phase 5.4 — Prisma Client 进程级单例。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么用单例?
 * ─────────────────────────────────────────────────────────────────────
 *
 * PrismaClient 实例内部:
 *   - 持有数据库连接池
 *   - 持有 prepared statements
 *   - 持有 query engine 子进程(对某些 db,不是 SQLite)
 *
 * 每 `new PrismaClient()` 一次就会**新开一组资源**,代价不便宜。
 * 如果业务代码每次请求都 new 一个,几百 QPS 时会有泄漏 / 性能问题。
 *
 * 正确做法:**全进程共享一个实例**,所有业务文件 import 同一个变量。
 *
 *
 * # 为什么不用 closure factory(像 sqliteCheckpointer 那种 getXxx)?
 *
 * 那种"延迟创建 + 缓存"的模式对**有副作用**的资源(打开文件、启子进程)合适。
 *
 * PrismaClient 的 lazy 行为已经做得很好:
 *   - new PrismaClient() 是 cheap(O(1) 内存分配)
 *   - 真正连接数据库是第一次 query 时(.$connect() 或第一次 .findMany() 等)
 *
 * 所以这里直接 `export const prisma = new PrismaClient()` 即可,
 * 模块第一次被 import 时执行,之后所有 import 拿到的都是同一份。
 *
 *
 * # 进程退出时怎么清理?
 *
 * Node.js 进程退出时所有打开的连接会自动关闭,**正常情况下不需要手动 disconnect**。
 * 但调试脚本(prismaDebug.ts)那种"跑完就退"的场景,显式 $disconnect()
 * 能让 Node 立刻退出,不用等待 fs/net handle 关闭超时。
 *
 * 服务端 Express 是长跑进程,**不要在请求 handler 里调 disconnect**——
 * 那会断掉 client,后续请求就挂了。
 */

export const prisma = new PrismaClient();
