import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  buildToolDoneEvent,
  buildToolStartEvent,
  executeAgentTool,
  getAgentTools,
  stringifyToolResult,
} from "./agentTools";
import { buildToolErrorResult } from "./agentToolTypes";
import {
  getDurationMs,
  getToolCallLogData,
  logAgentError,
  logAgentInfo,
} from "./agentObservability";
import { buildAgentInstructions } from "../chat/prompts";
import type {
  ChatStreamEvent,
  DeepSeekAssistantMessageWithReasoning,
  NormalizedChatHistoryItem,
} from "../shared/types";

const maxAgentToolSteps = 4;
const toolExecutionTimeoutMs = 8000;

export type AgentRunResult = {
  messages: ChatCompletionMessageParam[];
  toolCallCount: number;
};

function buildAgentMessages(
  message: string,
  systemPrompt: string | undefined,
  history: NormalizedChatHistoryItem[]
): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: buildAgentInstructions(systemPrompt),
    },
    ...history.map((item): ChatCompletionMessageParam => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user",
      content: message,
    },
  ];
}

/**
 * 把模型返回的 assistant tool_call 消息整理成下一轮请求可用的 message。
 *
 * DeepSeek thinking mode 要求 reasoning_content 原样传回。
 * OpenAI SDK 类型里没有这个字段，所以用本地扩展类型保留。
 */
function buildAssistantToolMessage(
  assistantMessage: DeepSeekAssistantMessageWithReasoning,
  toolCalls: ChatCompletionMessageToolCall[]
): ChatCompletionAssistantMessageParam {
  const assistantToolMessage: DeepSeekAssistantMessageWithReasoning = {
    role: "assistant",
    content: assistantMessage.content ?? null,
    tool_calls: toolCalls,
  };

  if (typeof assistantMessage.reasoning_content === "string") {
    assistantToolMessage.reasoning_content = assistantMessage.reasoning_content;
  }

  return assistantToolMessage;
}

function getToolDefinitionName(tool: ChatCompletionTool): string {
  if (tool.type === "function") {
    return tool.function.name;
  }

  return tool.type;
}

function getToolCallName(toolCall: ChatCompletionMessageToolCall): string {
  /**
   * 当前项目只支持 function tool call。
   * 这里仍然保留 unknown 分支，是为了防止未来 SDK 增加新 tool_call 类型时，
   * 日志和错误结果至少还能带一个稳定的工具名字段。
   */
  return toolCall.type === "function" ? toolCall.function.name : "unknown";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return "Unknown error";
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  /**
   * 给单个异步操作加超时保护。
   *
   * 注意：Promise 超时不能真正“杀掉”底层工作，例如已经发给 MCP server 的请求
   * 可能仍会在后台完成。这里的目标是保护 Agent 主链路：
   * 用户不应该因为某个工具迟迟不返回而一直等不到最终回答。
   *
   * operation.then(..., ...) 会同时接住底层成功和失败，避免超时返回后底层 promise
   * 再 reject 造成未处理异常。
   */
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

type RunAgentToolLoopOptions = {
  deepseek: OpenAI;
  requestId: string;
  model: string;
  message: string;
  systemPrompt: string | undefined;
  history: NormalizedChatHistoryItem[];
  onToolEvent?: (event: ChatStreamEvent) => void;
};

/**
 * 执行 Agent 的“工具调用阶段”。
 *
 * 阶段 1：非流式 tool calling，模型决定是否调用工具，后端执行工具。
 * 阶段 2：由 server.ts 继续用 stream: true 输出最终回答。
 */
export async function runAgentToolLoop({
  deepseek,
  requestId,
  model,
  message,
  systemPrompt,
  history,
  onToolEvent,
}: RunAgentToolLoopOptions): Promise<AgentRunResult> {
  const loopStartedAt = Date.now();

  // Agent 先构造 messages。
  // 因为 DeepSeek 不是只看当前一句话，它需要知道系统规则、历史上下文、当前问题。
  /**
   * [
   *   { role: "system", content: "你是 iOS 学习助手，可以使用工具..." },
   *   { role: "user", content: "上一轮问题" },
   *   { role: "assistant", content: "上一轮回答" },
   *   { role: "user", content: "当前问题" }
   * ]
   */
  // buildAgentMessages 它先构造消息。
  const messages = buildAgentMessages(message, systemPrompt, history);

  logAgentInfo(requestId, "tool_loop", "messages_prepared", {
    model,
    historyCount: history.length,
    messageCount: messages.length,
    maxAgentToolSteps,
  });

  /**
   * 这里拿到的是“给模型看的工具定义”。
   *
   * 注意这个工具列表已经经过了一次转换：
   * MCP tools -> OpenAI-compatible tools。
   *
   * 模型不会知道背后是 MCP，它只知道自己可以返回 tool_calls。
   * 后端收到 tool_calls 后，才通过 MCP client 调用真正的 MCP server。
   */
  /**
   * Agent 从 MCP 获取工具列表
   *
   * agentRunner
   * -> agentTools.getAgentTools()
   * -> mcpClient.getMcpAgentTools()
   * -> MCP server listTools()
   *
   * 为什么要从 MCP 获取？
   * 因为工具定义不写死在 DeepSeek 请求里，而是由 MCP server 统一暴露。以后你增加新工具时，核心 Agent 流程不用大改。
   */
  // 然后拿工具列表。
  // 这里拿到的工具不是手写死的，而是来自 MCP server。
  const loadToolsStartedAt = Date.now();
  let agentTools: ChatCompletionTool[] = [];

  try {
    agentTools = await getAgentTools();
  } catch (error) {
    logAgentError(requestId, "tool_setup", "tools_load_failed", error, {
      durationMs: getDurationMs(loadToolsStartedAt),
    });

    /**
     * 工具列表加载失败时，不把整次请求判失败。
     *
     * 这通常表示 MCP server 没启动成功、stdio 连接断了，或者本地工具层临时不可用。
     * 但用户的问题仍然可以让模型用通用知识回答，所以这里降级成“无工具回答”：
     * - 返回当前 messages
     * - server.ts 后续仍然会走最终 stream
     * - 日志里能看到 fallback 原因和 requestId
     */
    logAgentInfo(requestId, "tool_setup", "fallback_to_no_tools", {
      durationMs: getDurationMs(loadToolsStartedAt),
      reason: "tools_load_failed",
    });

    return {
      messages,
      toolCallCount: 0,
    };
  }

  logAgentInfo(requestId, "tool_setup", "tools_loaded", {
    durationMs: getDurationMs(loadToolsStartedAt),
    toolCount: agentTools.length,
    toolNames: agentTools.map(getToolDefinitionName),
  });

  if (agentTools.length === 0) {
    /**
     * MCP 正常响应但没有暴露工具时，也按无工具模式继续。
     * 这不是错误，只是说明本轮 Agent 没有可用外部能力。
     */
    logAgentInfo(requestId, "tool_setup", "fallback_to_no_tools", {
      durationMs: getDurationMs(loadToolsStartedAt),
      reason: "empty_tool_list",
    });

    return {
      messages,
      toolCallCount: 0,
    };
  }

  let toolCallCount = 0;
  let stoppedBecauseMaxStepsReached = true;

  for (let step = 0; step < maxAgentToolSteps; step += 1) {
    /**
     * 然后让 DeepSeek 决定是否调用工具
     *
     * 工具决策阶段使用非流式请求。
     *
     * 原因：
     * - 第一版学习项目里，非流式 tool calling 更容易理解和调试
     * - DeepSeek 返回完整 assistant message 后，才能稳定拿到 tool_calls
     * - 工具阶段结束后，最终回答仍然会走 stream: true，保证 iOS 体验
     *
     * 这一阶段不是流式，因为要先完整拿到 tool_calls
     */
    /**
     * DeepSeek 判断要不要调用工具
     *
     * 这里非常核心。
     * 这一步 DeepSeek 做的不是最终回答，而是“决策”：
     * 我是否需要调用工具？
     * 如果需要，调用哪个工具？
     * 参数是什么？
     *
     * 注意：DeepSeek 不直接查知识库。它只是提出“我要调用这个工具”
     */
    /**
     * {
     *   "tool_calls": [
     *     {
     *       "function": {
     *         "name": "searchKnowledge",
     *         "arguments": "{\"query\":\"SwiftUI @State\"}"
     *       }
     *     }
     *   ]
     * }
     */
    const decisionStartedAt = Date.now();

    logAgentInfo(requestId, "tool_decision", "started", {
      step,
      model,
      messageCount: messages.length,
      toolCount: agentTools.length,
    });

    let completion: ChatCompletion;

    try {
      completion = await deepseek.chat.completions.create({
        model,
        messages,
        // tools：告诉模型有哪些工具可以用。
        tools: agentTools,
        // tool_choice: "auto"：让模型自己判断要不要调用工具。
        tool_choice: "auto",
      });
    } catch (error) {
      logAgentError(requestId, "tool_decision", "failed", error, {
        step,
        durationMs: getDurationMs(decisionStartedAt),
      });
      throw error;
    }

    const assistantMessage = completion.choices[0]
      ?.message as DeepSeekAssistantMessageWithReasoning | undefined;

    if (!assistantMessage) {
      logAgentInfo(requestId, "tool_decision", "no_assistant_message", {
        step,
        durationMs: getDurationMs(decisionStartedAt),
      });
      stoppedBecauseMaxStepsReached = false;
      break;
    }

    // 如果模型返回工具调用。
    const toolCalls = assistantMessage.tool_calls || [];

    logAgentInfo(requestId, "tool_decision", "completed", {
      step,
      durationMs: getDurationMs(decisionStartedAt),
      modelCalledTools: toolCalls.length > 0,
      toolCallCount: toolCalls.length,
      toolCalls: toolCalls.map(getToolCallLogData),
    });

    if (toolCalls.length === 0) {
      /**
       * 没有 tool_calls 表示模型认为工具阶段结束。
       * 后续由 server.ts 使用 agentRun.messages 开启最终流式回答。
       */
      stoppedBecauseMaxStepsReached = false;
      break;
    }

    toolCallCount += toolCalls.length;

    /**
     * OpenAI-compatible tool calling 要求：
     * assistant 的 tool_calls 消息必须放回 messages，
     * 然后每个 tool_call 再配一条 role=tool 的结果消息。
     *
     * 这样下一轮模型才能知道：
     * “我刚才请求了哪个工具，工具返回了什么结果。”
     */
    messages.push(buildAssistantToolMessage(assistantMessage, toolCalls));

    // 后端就循环执行，后端真正执行工具。
    /**
     * 模型不是直接执行工具
     * 模型只是说：“我想调用 searchKnowledge，参数是 xxx。”
     * 真正执行工具的是后端。
     * 执行完后，后端把结果作为 role: "tool" 放回 messages，让模型继续理解。
     */
    /**
     * 1. 先告诉 iOS：工具开始了。
     * 2. 后端执行工具。
     * 3. 再告诉 iOS：工具完成了。
     * 4. 把工具结果放回 messages，准备交给 DeepSeek。
     *
     * 为什么工具结果要放回 messages？
     * 因为 DeepSeek 需要看到工具返回了什么，才能基于工具结果生成最终答案。
     */
    for (const toolCall of toolCalls) {
      const toolStartedAt = Date.now();
      const toolLogData = getToolCallLogData(toolCall);
      const toolName = getToolCallName(toolCall);

      logAgentInfo(requestId, "tool_execution", "started", {
        step,
        timeoutMs: toolExecutionTimeoutMs,
        ...toolLogData,
      });

      onToolEvent?.(buildToolStartEvent(toolCall));

      /**
       * 真实执行从这里进入 MCP：
       * executeAgentTool -> mcpClient.callTool -> mcpServer handler。
       */
      let toolResult: Awaited<ReturnType<typeof executeAgentTool>>;
      let recoveredFromToolFailure = false;

      try {
        toolResult = await withTimeout(
          executeAgentTool(toolCall),
          toolExecutionTimeoutMs,
          `Tool execution timed out after ${toolExecutionTimeoutMs}ms.`
        );
      } catch (error) {
        recoveredFromToolFailure = true;

        logAgentError(requestId, "tool_execution", "recovered_as_tool_error", error, {
          step,
          durationMs: getDurationMs(toolStartedAt),
          timeoutMs: toolExecutionTimeoutMs,
          ...toolLogData,
        });

        /**
         * 这是本轮稳定性增强的关键点：
         *
         * 以前工具执行 throw 会一路冒泡到 server.ts，导致整个 SSE 回答失败。
         * 现在把异常包装成一条标准 tool result：
         *   { toolName, ok:false, error:"..." }
         *
         * 这样模型最终回答时仍然能看到“工具失败了”，并可以自然降级：
         * - 说明没有拿到工具结果
         * - 用通用知识继续回答
         * - 或提醒用户稍后重试
         */
        toolResult = buildToolErrorResult(
          toolName,
          `Tool execution failed: ${getErrorMessage(error)}`
        );
      }

      logAgentInfo(requestId, "tool_execution", "completed", {
        step,
        durationMs: getDurationMs(toolStartedAt),
        ...toolLogData,
        ok: toolResult.ok,
        recoveredFromToolFailure,
        result: toolResult,
      });

      onToolEvent?.(buildToolDoneEvent(toolCall, toolResult));

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: stringifyToolResult(toolResult),
      });
    }
  }

  if (stoppedBecauseMaxStepsReached) {
    /**
     * 走到这里说明每一轮模型都继续返回 tool_calls，直到达到 maxAgentToolSteps。
     * 上限保护可以避免模型陷入“调用工具 -> 看结果 -> 继续调用工具”的无限循环。
     *
     * 达到上限后不再继续工具阶段，直接让模型基于已有工具结果生成最终回答。
     */
    logAgentInfo(requestId, "tool_loop", "max_tool_steps_reached", {
      maxAgentToolSteps,
      toolCallCount,
      messageCount: messages.length,
    });
  }

  logAgentInfo(requestId, "tool_loop", "completed", {
    durationMs: getDurationMs(loopStartedAt),
    modelCalledTools: toolCallCount > 0,
    toolCallCount,
    finalMessageCount: messages.length,
  });

  return {
    messages,
    toolCallCount,
  };
}
