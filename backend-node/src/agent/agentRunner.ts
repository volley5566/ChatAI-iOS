/**
 * ═══════════════════════════════════════════════════════════════════
 * agent/agentRunner.ts — Agent 灰度路由入口
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   server.ts → 这个文件 → langchain/agentRunner.ts 或 langchain/agentGraph.ts
 *
 * server.ts 始终 import 这个文件的 runLangChainAgentStream,
 * 我们在这一层做新旧实现的切换,server.ts 完全不用改。
 *
 * 切换逻辑:
 *   USE_LANGGRAPH=false (默认) → Phase 3 createAgent 路径
 *   USE_LANGGRAPH=true          → Phase 4 手写 StateGraph 路径
 *
 * 两条路径的函数签名和返回值类型完全一致,可以无缝替换。
 */

import { useLangGraph } from "../config/env";
import {
  runLangChainAgentStream as runPhase3LangChainAgent,
  type LangChainAgentRunResult,
} from "../langchain/agentRunner";
import { runLangGraphAgentStream } from "../langchain/agentGraph";

export type AgentRunResult = LangChainAgentRunResult;

export async function runLangChainAgentStream(
  ...args: Parameters<typeof runPhase3LangChainAgent>
): Promise<AgentRunResult> {
  // useLangGraph 在 env.ts 启动时读取一次,改 .env 后需要重启才生效
  if (useLangGraph) {
    return runLangGraphAgentStream(...args);
  }

  return runPhase3LangChainAgent(...args);
}
