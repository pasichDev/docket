import { randomFillSync } from "node:crypto";

/**
 * RFC 9562 UUID version 7: a 48-bit millisecond timestamp followed by random
 * bits. Time-ordered (sorts correctly as a plain string) unlike v4, which
 * matters for a sync log where "what happened in what order" is meaningful —
 * even though correctness here doesn't depend on it (uuid equality is all
 * the merge logic needs), sortability is a real, free benefit.
 */
export function uuidv7(): string {
  const bytes = Buffer.alloc(16);
  const tsHex = BigInt(Date.now()).toString(16).padStart(12, "0").slice(-12); // 48 bits, truncate on the (year-10889) overflow side
  bytes.set(Buffer.from(tsHex, "hex"), 0);
  randomFillSync(bytes, 6, 10);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
