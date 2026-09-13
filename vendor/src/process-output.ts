import { isAscii } from "node:buffer";

export const OUTPUT_CHUNK_BYTES = 16 * 1024;

export type ProcessOutputStream = "stdout" | "stderr";

export interface OutputChunk {
  seq: number;
  stream: ProcessOutputStream;
  data: Buffer;
}

function isContinuationByte(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

function utf8SequenceLengthAt(data: Buffer, offset: number, final: boolean): number | undefined {
  const first = data[offset]!;
  if (first <= 0x7f) return 1;

  let length = 0;
  if (first >= 0xc2 && first <= 0xdf) length = 2;
  else if (first >= 0xe0 && first <= 0xef) length = 3;
  else if (first >= 0xf0 && first <= 0xf4) length = 4;
  else return 1;

  if (offset + 1 >= data.length) return final ? 1 : undefined;
  const second = data[offset + 1]!;
  if (!isContinuationByte(second)) return 1;
  if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f)) return 1;
  if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) return 1;
  for (let index = 2; index < length; index += 1) {
    if (offset + index >= data.length) return final ? 1 : undefined;
    if (!isContinuationByte(data[offset + index]!)) return 1;
  }
  return length;
}

export function splitOutputChunks(
  data: Buffer,
  final = false,
): { chunks: Buffer[]; remainder: Buffer } {
  if (isAscii(data)) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(offset, offset + OUTPUT_CHUNK_BYTES)));
    }
    return { chunks, remainder: Buffer.alloc(0) };
  }

  const chunks: Buffer[] = [];
  let chunkStart = 0;
  let cursor = 0;
  while (cursor < data.length) {
    const sequenceLength = utf8SequenceLengthAt(data, cursor, final);
    if (sequenceLength === undefined) break;
    if (cursor > chunkStart && cursor + sequenceLength - chunkStart > OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
      chunkStart = cursor;
      continue;
    }
    cursor += sequenceLength;
    if (cursor - chunkStart === OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
      chunkStart = cursor;
    }
  }
  if (cursor > chunkStart) chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
  return { chunks, remainder: Buffer.from(data.subarray(cursor)) };
}
