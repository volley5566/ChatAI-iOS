import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import type { NormalizedChatHistoryItem } from "../shared/types";

/**
 * ═══════════════════════════════════════════════════════════════════
 * langchain/chatPrompt.ts — 普通 RAG 聊天的 Prompt 模板 + content 工具
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   chat/chatCompletion.ts → buildLangChainRagMessages → 给 ChatDeepSeek
 *
 * # ChatPromptTemplate 是什么
 *   LangChain 把 prompt 抽成"模板对象",而不是手写数组:
 *     [
 *       { role: "system", content: instructions },
 *       ...history,
 *       { role: "user", content: message }
 *     ]
 *   好处:
 *     - 占位符 {instructions} / {message} 让 prompt 可参数化
 *     - MessagesPlaceholder 让 history 数组优雅插入
 *     - 输出标准 BaseMessage[],ChatDeepSeek 直接消费
 */
const ragChatPrompt = ChatPromptTemplate.fromMessages([
  ["system", "{instructions}"],
  new MessagesPlaceholder("history"),
  ["human", "{message}"],
]);

export async function buildLangChainRagMessages(
  instructions: string,
  history: NormalizedChatHistoryItem[],
  message: string
): Promise<BaseMessage[]> {
  return ragChatPrompt.formatMessages({
    instructions,
    history: history.map(toLangChainHistoryMessage),
    message,
  });
}

export function messageContentToString(content: BaseMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  /**
   * LangChain message content 也支持多模态数组。
   * 当前项目只发纯文本，但这里做一个保守转换，避免未来加入图片/文件后直接崩。
   */
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if ("text" in part && typeof part.text === "string") {
        return part.text;
      }

      return JSON.stringify(part);
    })
    .join("");
}

function toLangChainHistoryMessage(item: NormalizedChatHistoryItem): BaseMessage {
  if (item.role === "user") {
    return new HumanMessage(item.content);
  }

  return new AIMessage(item.content);
}
