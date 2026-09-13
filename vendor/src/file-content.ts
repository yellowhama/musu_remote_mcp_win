import { isUtf8 } from "node:buffer";

export type FileContentEncoding = "utf8" | "base64";

export function encodeContent(data: Buffer, encoding: FileContentEncoding): string {
  return encoding === "base64" ? data.toString("base64") : data.toString("utf8");
}

export function decodeBase64(data: string): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid base64 content");
  const content = data.replace(/=+$/, "");
  const suppliedPadding = data.length - content.length;
  if (content.length % 4 === 1) throw new Error("Invalid base64 content length");
  const requiredPadding = (4 - (content.length % 4)) % 4;
  if (suppliedPadding > 0 && suppliedPadding !== requiredPadding) {
    throw new Error("Invalid base64 padding");
  }
  const canonical = `${content}${"=".repeat(requiredPadding)}`;
  const decoded = Buffer.from(canonical, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== content) {
    throw new Error("Invalid base64 content");
  }
  return decoded;
}

export function decodeContent(data: string, encoding: FileContentEncoding): Buffer {
  return encoding === "base64" ? decodeBase64(data) : Buffer.from(data, "utf8");
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte <= 0x7f) return 1;
  if (firstByte >= 0xc2 && firstByte <= 0xdf) return 2;
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3;
  if (firstByte >= 0xf0 && firstByte <= 0xf4) return 4;
  return 0;
}

export function utf8ChunkLength(
  buffer: Buffer,
  requestedBytes: number,
  absoluteOffset: number,
  reachesEndOfFile: boolean,
): number {
  let cursor = 0;
  let lastBoundary = 0;
  while (cursor < buffer.length) {
    if (cursor >= requestedBytes && lastBoundary > 0) return lastBoundary;
    const sequenceLength = utf8SequenceLength(buffer[cursor]!);
    if (sequenceLength === 0) {
      throw new Error(`Invalid UTF-8 at byte offset ${absoluteOffset + cursor}; use encoding=base64`);
    }
    const nextBoundary = cursor + sequenceLength;
    if (nextBoundary > buffer.length) {
      if (reachesEndOfFile) {
        throw new Error(`Truncated UTF-8 at byte offset ${absoluteOffset + cursor}; use encoding=base64`);
      }
      break;
    }
    if (!isUtf8(buffer.subarray(cursor, nextBoundary))) {
      throw new Error(`Invalid UTF-8 at byte offset ${absoluteOffset + cursor}; use encoding=base64`);
    }
    if (nextBoundary > requestedBytes) return lastBoundary === 0 ? nextBoundary : lastBoundary;
    lastBoundary = nextBoundary;
    cursor = nextBoundary;
  }
  return lastBoundary;
}
