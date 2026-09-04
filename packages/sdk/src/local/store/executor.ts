import type { LocalDb } from "./open.js";

/**
 * Whatever the store's layers run their statements against.
 *
 * Every layer takes one of these rather than the database itself, so the
 * same code serves a plain read and a statement inside an interactive
 * transaction. Derived from drizzle's own callback parameter rather than
 * spelled out, because the transaction type carries the schema's generics
 * and restating them is how the two drift.
 */
export type LocalTransaction = Parameters<
  Parameters<LocalDb["transaction"]>[0]
>[0];

export type Executor = LocalDb | LocalTransaction;
