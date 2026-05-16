import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
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
 * 这样你能看到 LangChain prompt 的标准写法，同时输出仍然可以转成
 * OpenAI-compatible messages，方便和现有 DeepSeek / Agent 代码共存。
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

export function langChainMessagesToOpenAiMessages(
  messages: BaseMessage[]
): ChatCompletionMessageParam[] {
  /**
   * /api/chat 和 /api/chat/stream 已经可以用 LangChain ChatDeepSeek。
   *
   * 但项目里仍然保留 OpenAI-compatible SDK：
   * - Agent tool loop 还在用 tools/tool_choice 的低层格式
   * - DeepSeek reasoning_content 需要精细兼容
   *
   * 所以这里保留一个转换函数，方便不同层按自己的格式消费同一份 prompt。
   */
  return messages.map((message): ChatCompletionMessageParam => {
    const content = messageContentToString(message.content);
    const messageType = message._getType();

    if (messageType === "system") {
      return {
        role: "system",
        content,
      };
    }

    if (messageType === "human") {
      return {
        role: "user",
        content,
      };
    }

    return {
      role: "assistant",
      content,
    };
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

export function toLangChainMessages(
  messages: ChatCompletionMessageParam[]
): BaseMessage[] {
  /**
   * 这个函数主要给“旧 OpenAI-compatible messages -> LangChain model”过渡使用。
   * 普通 RAG 路径会优先从 ChatPromptTemplate 直接生成 BaseMessage。
   */
  return messages.map((message) => {
    const content = typeof message.content === "string" ? message.content : "";

    switch (message.role) {
      case "system":
        return new SystemMessage(content);
      case "user":
        return new HumanMessage(content);
      default:
        return new AIMessage(content);
    }
  });
}
