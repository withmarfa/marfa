export const EVENT_LIMITS = {
  keepAliveMs: 30_000,
  replayBatchSize: 500,
  headReadTimeoutMs: 5_000,
  maxUnsentBytes: 4 * 1024 * 1024,
  readerStallMs: 30_000,
  roomPollMs: 50,
} as const;
