export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 32 * 1024;

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ack"; bytes: number };

export type ServerMessage =
  | { type: "ready"; version: number }
  | { type: "output"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const msg = value as Record<string, unknown>;
  if (
    msg.type === "input" &&
    typeof msg.data === "string" &&
    msg.data.length <= 8192
  )
    return { type: "input", data: msg.data };
  if (
    msg.type === "resize" &&
    Number.isInteger(msg.cols) &&
    Number.isInteger(msg.rows) &&
    Number(msg.cols) >= 2 &&
    Number(msg.cols) <= 500 &&
    Number(msg.rows) >= 1 &&
    Number(msg.rows) <= 300
  )
    return { type: "resize", cols: Number(msg.cols), rows: Number(msg.rows) };
  if (
    msg.type === "ack" &&
    Number.isInteger(msg.bytes) &&
    Number(msg.bytes) > 0 &&
    Number(msg.bytes) <= 1024 * 1024
  )
    return { type: "ack", bytes: Number(msg.bytes) };
  return null;
}
