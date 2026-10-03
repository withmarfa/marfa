export class ReadSnapshotUnavailable extends Error {
  constructor() {
    super("The read snapshot is unavailable");
    this.name = "ReadSnapshotUnavailable";
  }
}

export class ReadLifetime {
  deadlineAt: number;
  abandoned = false;
  private timer?: ReturnType<typeof setTimeout>;
  private reject!: (error: Error) => void;
  private readonly ended: Promise<never>;
  private readonly listeners = new Map<
    AbortSignal,
    { count: number; remove: () => void }
  >();

  constructor(options?: { deadlineAt?: number; signal?: AbortSignal }) {
    this.deadlineAt = Date.now() + 5_000;
    this.ended = new Promise<never>((_, reject) => {
      this.reject = reject;
    });
    void this.ended.catch(() => undefined);
    this.watch(options?.signal);
    this.shorten(options);
  }

  abandon = (): void => {
    if (this.abandoned) return;
    this.abandoned = true;
    this.reject(new ReadSnapshotUnavailable());
  };

  shorten(options?: { deadlineAt?: number; signal?: AbortSignal }): void {
    if (options?.deadlineAt !== undefined) {
      if (!Number.isFinite(options.deadlineAt)) this.abandon();
      else this.deadlineAt = Math.min(this.deadlineAt, options.deadlineAt);
    }
    if (options?.signal?.aborted) this.abandon();
    clearTimeout(this.timer);
    if (Date.now() >= this.deadlineAt) this.abandon();
    else this.timer = setTimeout(this.abandon, this.deadlineAt - Date.now());
  }

  assertAlive(): void {
    if (Date.now() >= this.deadlineAt) this.abandon();
    if (this.abandoned) throw new ReadSnapshotUnavailable();
  }

  watch(signal?: AbortSignal): () => void {
    if (!signal) return () => undefined;
    if (signal.aborted) {
      this.abandon();
      return () => undefined;
    }
    const entry = this.listeners.get(signal);
    if (entry) entry.count++;
    else {
      signal.addEventListener("abort", this.abandon, { once: true });
      this.listeners.set(signal, {
        count: 1,
        remove: () => {
          signal.removeEventListener("abort", this.abandon);
        },
      });
    }
    return () => {
      const current = this.listeners.get(signal);
      if (current && --current.count === 0) {
        current.remove();
        this.listeners.delete(signal);
      }
    };
  }

  async wait<T>(work: Promise<T>): Promise<T> {
    void work.catch(() => undefined);
    this.assertAlive();
    const result = await Promise.race([work, this.ended]);
    this.assertAlive();
    return result;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const entry of this.listeners.values()) entry.remove();
    this.listeners.clear();
  }
}
