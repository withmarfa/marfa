/**
 * Local declarations for the JS-only `pg-boss` 10.x API surface we
 * consume. Kept minimal — only the methods the local runtime substrate
 * actually calls. If pg-boss ships its own types in a later release, we
 * delete this file and import from `pg-boss` directly.
 */

export interface PgBossJob<T = unknown> {
  id: string;
  data: T;
}

export interface PgBossWorkOptions {
  /** Maximum dispatches running concurrently inside this worker. */
  batchSize?: number;
  /** Time the worker is allowed to take per dispatch before pg-boss
   *  considers it failed. Defaults to pg-boss's own ceiling; we set
   *  it explicitly so a hung handler doesn't pin the worker forever. */
  expireInSeconds?: number;
  /** Polling cadence in milliseconds. */
  pollingIntervalSeconds?: number;
}

export interface PgBossSendOptions {
  /** Coalesces concurrent inserts of the same key — pg-boss enforces a
   *  uniqueness window on the `singletonKey` column. Used to dedupe
   *  schedule fan-out under race conditions. */
  singletonKey?: string;
  singletonSeconds?: number;
}

export interface PgBossScheduleOptions {
  /** Single instance globally — only one cron tick fires regardless of
   *  how many server instances are running. */
  tz?: string;
}

export interface PgBoss {
  start(): Promise<PgBoss>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  createQueue(name: string, options?: unknown): Promise<void>;
  send(
    name: string,
    data: unknown,
    options?: PgBossSendOptions,
  ): Promise<string>;
  work<T>(
    name: string,
    options: PgBossWorkOptions,
    handler: (jobs: PgBossJob<T>[]) => Promise<void>,
  ): Promise<string>;
  schedule(
    name: string,
    cron: string,
    data?: unknown,
    options?: PgBossScheduleOptions,
  ): Promise<void>;
  unschedule(name: string): Promise<void>;
}

export type PgBossCtor = new (connectionString: string) => PgBoss;
