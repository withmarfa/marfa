import { HeldLock } from "./held-lock.js";

/** Admit and hold a real write transaction before closing its connection. */
export async function witnessWriteAdmission(sqlitePath: string): Promise<void> {
  const lock = await HeldLock.take(sqlitePath);
  await lock.release();
}
