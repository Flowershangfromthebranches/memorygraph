import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface JsonLine {
  value: Record<string, unknown>;
  start: number;
  end: number;
}

export function fileContainsText(path: string, needle: string): boolean {
  const target = Buffer.from(needle, "utf8");
  if (target.length === 0) return true;
  const descriptor = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(65_536);
  let carry = Buffer.alloc(0);
  try {
    while (true) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) return false;
      const combined = Buffer.concat([carry, chunk.subarray(0, count)]);
      if (combined.indexOf(target) >= 0) return true;
      const overlap = Math.min(target.length - 1, combined.length);
      carry = Buffer.from(combined.subarray(combined.length - overlap));
    }
  } finally {
    closeSync(descriptor);
  }
}

export function readFirstJsonObject(path: string, maxBytes = 1_048_576): Record<string, unknown> | null {
  const descriptor = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(65_536, maxBytes - total));
      const count = readSync(descriptor, buffer, 0, buffer.length, total);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk);
      total += count;
    }
    const line = Buffer.concat(chunks).toString("utf8").trim();
    if (!line) return null;
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } finally {
    closeSync(descriptor);
  }
}

export function readJsonLines(path: string, requestedOffset: number): { lines: JsonLine[]; nextOffset: number; size: number; mtimeMs: number } {
  const stat = statSync(path);
  const offset = requestedOffset > stat.size ? 0 : Math.max(0, requestedOffset);
  const buffer = Buffer.allocUnsafe(stat.size - offset);
  let bytesRead = 0;
  const descriptor = openSync(path, "r");
  try {
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(descriptor);
  }
  const readable = buffer.subarray(0, bytesRead);
  const lines: JsonLine[] = [];
  let cursor = 0;
  while (cursor < readable.length) {
    const newline = readable.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const start = cursor;
    const text = readable.subarray(start, newline).toString("utf8").trim();
    cursor = newline + 1;
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lines.push({ value: parsed as Record<string, unknown>, start: offset + start, end: offset + cursor });
      }
    } catch {
      // A corrupt line is skipped; the durable byte cursor prevents retry loops.
    }
  }
  return { lines, nextOffset: offset + cursor, size: stat.size, mtimeMs: stat.mtimeMs };
}
