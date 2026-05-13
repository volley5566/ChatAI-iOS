import type { Response } from "express";
import type { ChatStreamEvent } from "./types";

/**
 * 向 iOS 写一条 SSE 事件。
 *
 * SSE 的基本格式是：
 * data: {"type":"delta","delta":"hello"}
 *
 * 最后的空行 \n\n 用来告诉客户端“一条事件结束了”。
 */
export function writeSseEvent(res: Response, event: ChatStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
