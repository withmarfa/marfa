/** Background work a run starts, so that every part of it stops when the run ends. */
export class Tasks {
  private readonly stops: (() => Promise<unknown>)[] = [];

  /** Records `stop` and returns a version that runs it once, whoever calls it first. */
  own<T>(stop: () => Promise<T>): () => Promise<T> {
    let running: Promise<T> | undefined;
    const once = () => (running ??= stop());
    this.stops.push(once);
    return once;
  }

  /** Stops everything still running, a failure to stop one not holding up the rest. */
  async stopAll(): Promise<string[]> {
    const outcomes = await Promise.allSettled(this.stops.map((stop) => stop()));
    return outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [String(outcome.reason)] : [],
    );
  }
}
