import { spawnSync } from "node:child_process";
import path from "node:path";

export type WindowsEventType = "INFORMATION" | "WARNING" | "ERROR";

export function writeWindowsEvent(eventId: number, type: WindowsEventType, message: string): void {
  const source = process.env.MCP_WINDOWS_EVENT_LOG_SOURCE;
  if (process.platform !== "win32" || !source) return;
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "eventcreate.exe");
  const safeMessage = message.replace(/[\r\n]+/g, " ").slice(0, 8_000);
  const result = spawnSync(executable, [
    "/L", "APPLICATION", "/SO", source, "/T", type,
    "/ID", String(eventId), "/D", safeMessage,
  ], { windowsHide: true, timeout: 3_000, stdio: "ignore" });
  if (result.error || result.status !== 0) {
    console.error(`Windows Event Log write failed for event ${eventId}`);
  }
}
