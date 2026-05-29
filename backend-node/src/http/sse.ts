/**
 * ═══════════════════════════════════════════════════════════════════
 * http/sse.ts — SSE(Server-Sent Events)格式写出器
 * ═══════════════════════════════════════════════════════════════════
 *
 * 在整体流程中的位置:
 *   server.ts 的 /api/chat/stream 和 /api/agent/stream 路由都用这个函数
 *   把 ChatStreamEvent 写回 iOS。
 *
 * # SSE 协议格式
 *   每条事件三行:
 *     data: <JSON 字符串>
 *     <空行>
 *
 *   data: 行携带数据,最后的 \n\n 表示"一条事件结束"。
 *   iOS 那边一行行读 data:,再 JSON decode 成 ChatStreamEvent。
 *
 * # 为什么用 SSE 而不是 WebSocket
 *   SSE 是单向(服务器 → 客户端),够用且更简单:
 *     - 走标准 HTTP,所有代理/防火墙都支持
 *     - 浏览器有原生 EventSource API
 *     - 不需要心跳,断开会自动重连
 */

import type { Response } from "express";
import type { ChatStreamEvent } from "../shared/types";

export function writeSseEvent(res: Response, event: ChatStreamEvent): void {
  // 末尾的 \n\n 是 SSE 协议规定的"事件分隔符",不能省
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
