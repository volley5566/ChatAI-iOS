import type { Response } from "express";
import type { ChatStreamEvent } from "../shared/types";

/**
 * SSE 是怎么写回 iOS 的
 *
 * 向 iOS 写一条 SSE 事件。
 *
 * SSE 的基本格式是：
 * data: {"type":"delta","delta":"hello"}
 *
 * 最后的空行 \n\n 用来告诉客户端“一条事件结束了”。
 */
export function writeSseEvent(res: Response, event: ChatStreamEvent): void {
  // 重点是最后的 \n\n，它表示“一条事件结束”。
  // iOS 那边就是一行一行读 data:，然后 JSON decode。
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
