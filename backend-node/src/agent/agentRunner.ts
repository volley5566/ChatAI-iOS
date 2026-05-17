import { useLangGraph } from "../config/env";
import {
  runLangChainAgentStream as runPhase3LangChainAgent,
  type LangChainAgentRunResult,
} from "../langchain/agentRunner";
import { runLangGraphAgentStream } from "../langchain/agentGraph";

/**
 * Phase 4 — Agent Runner 灰度入口。
 *
 * ─────────────────────────────────────────────────────────────────────
 * server.ts 一直 import 这个文件的 runLangChainAgentStream,
 * 我们在这一层做新旧实现的切换,server.ts 完全不用改。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 流向:
 *
 *   USE_LANGGRAPH=false (默认) → Phase 3 createAgent 路径
 *   USE_LANGGRAPH=true          → Phase 4 手写 StateGraph 路径
 *
 * 两条路径的函数签名、返回值类型完全一致,所以可以无缝替换。
 *
 * 开发期推荐:
 *   1. 先 USE_LANGGRAPH=false 跑一遍,确认基线
 *   2. 切 USE_LANGGRAPH=true,跑同样 case 对比
 *   3. 两边行为一致 → 切默认值 → 后续清理 Phase 3 代码
 */

export type AgentRunResult = LangChainAgentRunResult;

export async function runLangChainAgentStream(
  ...args: Parameters<typeof runPhase3LangChainAgent>
): Promise<AgentRunResult> {
  /**
   * useLangGraph 在 env.ts 启动时读取一次。
   * 改 env 后需要重启后端才生效——这是 dotenv 的常规行为。
   */
  if (useLangGraph) {
    return runLangGraphAgentStream(...args);
  }

  return runPhase3LangChainAgent(...args);
}
