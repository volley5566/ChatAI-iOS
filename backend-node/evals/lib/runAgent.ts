/**
 * Phase 10.2 #7 — 把 Agent 包成纯函数,供 Eval 体系调用。
 *
 * ──────────────────────────────────────────────────────────────────
 * 正常请求里,Agent 跑在 Express 路由中,输出是 SSE 流,
 * 掺杂了 HTTP 协议细节(content-type / 事件格式 / 连接管理等)。
 *
 * Eval 不需要这些——只想知道:
 *   1. Agent 最终说了什么 → finalText
 *   2. 过程中调了哪些 tool → toolCalls(按调用顺序)
 *   3. 花了多久 → durationMs
 *   4. LangSmith trace id → rootRunId(可选,方便回看)
 *
 * 所以这个文件就是把 Agent 的 SSE 输出"解包"成一个干净的 EvalResult。
 *
 * Android 类比:
 *   就像你在 Android 里写单元测试时,不会启动整个 Activity + OkHttp,
 *   而是直接 new ViewModel() 然后调它的方法。
 *   runAgent() 就是绕过 HTTP 层直接调 Agent 逻辑。
 * ──────────────────────────────────────────────────────────────────
 */

import { randomUUID } from "node:crypto";

/**
 * 注意这里引用的是 agent/ 目录下的灰度入口(不是 langchain/ 下面的):
 *   - USE_LANGGRAPH=true  → 走 Phase 4 StateGraph
 *   - USE_LANGGRAPH=false → 走 Phase 3 createAgent
 *
 * 灰度逻辑完全复用,eval 跑的和线上跑的是同一条代码路径。
 * 如果 eval 直接 import agentGraph.ts,那就只测了 Phase 4,
 * 而跳过了灰度入口——万一线上跑的是 Phase 3 就白测了。
 */
import { runLangChainAgentStream } from "../../src/agent/agentRunner";

import type { EvalCase, EvalResult } from "./types";

/**
 * 把 Agent 调用包成纯函数。
 *
 * 给一条 EvalCase → 跑一次 Agent → 返回 EvalResult。
 *
 * 设计要点:
 *   - **不抛异常**:Agent 跑出错时把 error 存进 EvalResult.error,
 *     让 runEval 能区分"跑失败"和"跑成功但评分低"。
 *     如果抛了,runEval 要写 try-catch 还要决定怎么处理,逻辑散开。
 *
 *   - **无 SSE**:onDelta 直接拼字符串,onToolEvent 只收集 tool 名字,
 *     不往 HTTP response 写任何东西。
 *
 *   - **无持久化**:不传 threadId,每条 case 独立跑,互不影响。
 *     threadId 是给线上"续上对话"用的,eval 不需要。
 */
export async function runAgent(evalCase: EvalCase): Promise<EvalResult> {
  /**
   * 给每次调用生成一个 requestId。
   *
   * 线上是 server.ts 在每个 HTTP 请求进来时生成的,
   * eval 没有 HTTP 请求,所以自己造一个。
   * 作用:后端日志的 grep 标识 + LangSmith metadata。
   * 加 "eval-" 前缀方便在日志里一眼区分是 eval 跑的还是真实用户请求。
   */
  const requestId = `eval-${randomUUID()}`;

  /**
   * 收集 tool 调用名称。
   *
   * onToolEvent 在每次 tool_start / tool_done 时触发,
   * 我们只关心 tool_start(表示"Agent 决定调这个 tool 了"),
   * 不关心 tool_done(那个是"tool 跑完了",结果对 eval 评分不重要)。
   *
   * 按触发顺序 push → toolCalls 天然有序,给 toolChain evaluator 用。
   */
  const toolCalls: string[] = [];

  const startedAt = Date.now();

  try {
    const result = await runLangChainAgentStream({
      requestId,
      message: evalCase.input,
      /**
       * systemPrompt 传 undefined → Agent 用默认的 agentOutputGuide。
       * eval 不需要自定义 system prompt,就该测"线上默认行为"。
       */
      systemPrompt: undefined,
      /**
       * history 传空 → 没有对话历史,每条 case 都是"冷启动"。
       *
       * 即使是 multiturn 场景也传空——目的是测 Agent 在没有上下文时
       * 能否合理应对(比如提示用户"我没有之前的对话记录")。
       * 未来可以扩展 EvalCase 支持 history 字段,但目前 21 条够用。
       */
      history: [],
      /**
       * 不传 threadId → 无持久化,图跑完 state 丢弃。
       * eval 每条 case 独立,不需要跨 case 记忆。
       */
      // threadId: undefined,

      /**
       * onToolEvent:收集 tool 调用信息。
       * ChatStreamEvent 是一个联合类型,要窄化到 tool_start 才能拿 tool_name。
       */
      onToolEvent: (event) => {
        if (event.type === "tool_start") {
          toolCalls.push(event.tool_name);
        }
      },

      /**
       * onDelta:eval 不需要逐 token 回调,忽略即可。
       * Agent 的 outputText 已经在返回值里累积好了。
       */
      // onDelta: undefined,

      /**
       * shouldStop:eval 不需要中断,让 Agent 跑完。
       * 如果将来想加超时,可以在这里基于 Date.now() 做判断。
       */
      // shouldStop: undefined,
    });

    return {
      caseId: evalCase.id,
      finalText: result.outputText,
      toolCalls,
      rootRunId: result.rootRunId,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    /**
     * Agent 跑出异常:把 error 信息存进 EvalResult,不抛出去。
     *
     * 这样 runEval 拿到的每条 case 都有 EvalResult(只是 error 字段非空),
     * evaluator 看到 error 有值就全部 skip(score: null),
     * 报告能区分"失败"和"低分"——这个区分对定位问题很重要。
     */
    return {
      caseId: evalCase.id,
      finalText: "",
      toolCalls,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
