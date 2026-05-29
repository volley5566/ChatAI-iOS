import { Client } from "langsmith";

import { langSmithProject, langSmithTracingEnabled } from "../config/env";

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/langsmithClient.ts — LangSmith Client 单例 + 反馈写入接口
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   server.ts POST /api/feedback → submitUserFeedback() →
 *   langsmith Client.createFeedback() → smith.langchain.com
 *
 * # 为什么单独建一个文件
 *
 * 1. **单例复用** —— LangSmith Client 内部维护 HTTP 连接池、批量上报队列,
 *    全进程只该有一份。
 *
 * 2. **集中化判 LANGSMITH_TRACING** —— 多个地方调用(/api/feedback、eval 脚本等)
 *    都需要先判断开关,集中在一处免得每个调用点复制一遍。
 *
 * 3. **类型边界清晰** —— server.ts 不直接依赖 langsmith SDK,
 *    只看到 submitUserFeedback() 接口。换 SDK / 加重试 / 加 mock 都改这一个文件。
 *
 * 这是 Android 里 "Repository pattern" 的思路——
 * 业务代码不直接碰 Retrofit/OkHttp,中间隔一层 Repository。
 */

/**
 * 用 let + 懒加载,而不是模块顶层 `const client = new Client()`。
 *
 * 原因:Client 构造函数会读 LANGSMITH_API_KEY 等环境变量。
 * 如果模块在 dotenv.config() 之前被 import(很少见但可能),
 * 就会拿到 undefined。延迟到第一次 getClient() 调用时再 new,
 * 此时 env.ts 早已加载、dotenv 早已跑过,保证拿到正确值。
 */
let cachedClient: Client | null = null;

function getClient(): Client {
  if (!cachedClient) {
    /**
     * Client 构造默认会从环境变量读 LANGSMITH_API_KEY / LANGSMITH_ENDPOINT,
     * 所以不用显式传——保持和 LangChain 自动 trace 的行为一致。
     */
    cachedClient = new Client();
  }
  return cachedClient;
}

/**
 * 用户反馈写入失败时的错误类型。
 *
 * 业务层(server.ts)用 instanceof 判断是不是"LangSmith 没开"这种
 * 业务可知错误,从而返回 503 而不是无脑 500。
 */
export class LangSmithFeedbackDisabledError extends Error {
  constructor() {
    super(
      "LangSmith tracing is disabled. Set LANGSMITH_TRACING=true and LANGSMITH_API_KEY to enable feedback."
    );
    this.name = "LangSmithFeedbackDisabledError";
  }
}

export type SubmitUserFeedbackInput = {
  /**
   * LangSmith trace 的根 run id。
   * iOS 端从 SSE done 事件拿到(Phase 10.1 #3 会加),回传给本接口。
   */
  runId: string;
  /**
   * 评分,约定 0..1 区间:1 = 👍,0 = 👎。
   * 留浮点是为了将来支持星级(0.25 / 0.5 / 0.75 / 1)或 LLM judge 分数。
   */
  score: number;
  /**
   * 评分 key,LangSmith UI 里会按这个 key 聚合成一列。
   * 默认 "user_thumb" 表示"用户手动点的赞/踩"。
   * 加新维度(比如"用户标注答错了")传不同 key 即可。
   */
  key?: string;
  /** 可选评论(用户写的"为什么不好"),iOS 第一版不收集,留协议位置 */
  comment?: string;
};

export type SubmitUserFeedbackResult = {
  feedbackId: string;
};

/**
 * 把一次用户反馈写到对应 trace 上。
 *
 * 调用链:
 *   iOS 点击 👍/👎
 *     → POST /api/feedback { run_id, score }
 *     → submitUserFeedback()
 *     → langsmith Client.createFeedback()
 *     → smith.langchain.com 的 trace 详情页 Feedback 区出现一条
 *
 * 失败处理:
 * - LangSmith 没启用 → 抛 LangSmithFeedbackDisabledError(业务可知)
 * - 其它(网络 / 鉴权 / runId 不存在)→ 让原始错误冒泡,server 层统一记日志
 */
export async function submitUserFeedback(
  input: SubmitUserFeedbackInput
): Promise<SubmitUserFeedbackResult> {
  if (!langSmithTracingEnabled) {
    throw new LangSmithFeedbackDisabledError();
  }

  const client = getClient();
  const feedback = await client.createFeedback(input.runId, input.key ?? "user_thumb", {
    score: input.score,
    comment: input.comment,
    /**
     * 显式传 projectId/sessionId 不是必需的——LangSmith 会根据 runId
     * 自动定位到所属 project。这里留空,让 SDK 自己处理。
     *
     * 如果未来要支持"跨 project 的 feedback"(比如把生产 trace 的反馈
     * 挂到 eval project 上)再传 projectId / sessionId。
     */
  });

  /**
   * createFeedback 返回的 Feedback 对象里 id 字段是 string,
   * 但 TS 类型签名上 id 可能是 string | undefined(取决于 langsmith 版本)。
   * 用 String(...) 兜底转一下,保证返回给 iOS 的永远是 string。
   *
   * 顺便提一句:这里**故意不**给 iOS 返回 LangSmith 的内部细节(project_id 等),
   * 只回 feedbackId——iOS 唯一会用它做的事是"如果以后允许撤销反馈,带这个 id 来"。
   */
  void langSmithProject; // 仅占位:让上面注释里"知道项目名"的事实有迹可循
  return { feedbackId: String(feedback.id) };
}
