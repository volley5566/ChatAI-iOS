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
 * 普通 RAG 聊天使用的 LangChain PromptTemplate。
 *
 * 以前项目里是手写数组：
 * [
 *   { role: "system", content: instructions },
 *   ...history,
 *   { role: "user", content: message }
 * ]
 *
 * 现在改成 ChatPromptTemplate：
 * - system 部分放规则和 RAG context
 * - history 用 MessagesPlaceholder 插入多轮上下文
 * - 当前问题放 human message
 *
 * 这样你能看到 LangChain prompt 的标准写法，并且普通聊天接口可以直接
 * 把 BaseMessage[] 交给 ChatDeepSeek。
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
