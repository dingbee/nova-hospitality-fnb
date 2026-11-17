/**
 * A monotonic, durable local sequence counter — gives every queued
 * operation a strict creation order that survives refresh/restart, so
 * replay ordering (P10 Phase 9 "ordered operations where required") does
 * not depend on `createdAt` timestamp precision (two operations queued in
 * the same millisecond must still have a deterministic order).
 */
import { get, put, STORES } from "./db";

const SEQUENCE_KEY = "queue_sequence";

interface SequenceRecord {
  scopeKey: typeof SEQUENCE_KEY;
  value: number;
}

export async function nextSequence(): Promise<number> {
  const current = await get<SequenceRecord>(STORES.syncState, SEQUENCE_KEY);
  const next = (current?.value ?? 0) + 1;
  await put<SequenceRecord>(STORES.syncState, { scopeKey: SEQUENCE_KEY, value: next });
  return next;
}
