import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A connection sitting in `BEGIN IMMEDIATE` on the server's own file. */
export class HeldLock {
  private readonly closed: Promise<void>;
  private releasing: Promise<void> | undefined;
  private stderr = "";
  private error: Error | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.closed = new Promise((resolve) =>
      child.once("close", () => resolve()),
    );
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    const onError = (error: Error) => {
      this.error = error;
    };
    child.on("error", onError);
    child.stdin.on("error", onError);
  }

  static async take(
    sqlitePath: string,
    busyTimeoutMs = 5_000,
  ): Promise<HeldLock> {
    const child = spawn("sqlite3", ["-batch", "-bail", sqlitePath], {
      stdio: "pipe",
    });
    const lock = new HeldLock(child);
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.stdout.off("data", onOutput);
          child.stderr.off("data", onStderr);
          child.stdin.off("error", onError);
          child.off("error", onError);
          child.off("close", onClose);
          if (error) reject(error);
          else resolve();
        };
        const onOutput = (chunk: string) => {
          output += chunk;
          if (output.includes("held\n")) finish();
        };
        const onStderr = () =>
          finish(new Error(`sqlite3 refused lock admission: ${lock.stderr}`));
        const onError = (error: Error) => finish(error);
        const onClose = () =>
          finish(
            new Error(`sqlite3 exited before lock admission: ${lock.stderr}`),
          );
        const timer = setTimeout(
          () => finish(new Error("sqlite3 did not confirm it holds the lock")),
          10_000,
        );
        child.stdout.setEncoding("utf8").on("data", onOutput);
        child.stderr.on("data", onStderr);
        child.stdin.on("error", onError);
        child.on("error", onError);
        child.on("close", onClose);
        // Without bail, a failed BEGIN can still print the marker outside
        // a transaction. A finite wait admits a transient competing writer.
        child.stdin.write(
          `.timeout ${String(busyTimeoutMs)}\nPRAGMA journal_mode=WAL;\nBEGIN IMMEDIATE;\nSELECT 'held';\n`,
        );
      });
      return lock;
    } catch (error) {
      child.kill("SIGKILL");
      await lock.closed;
      throw error;
    }
  }

  /** Closing the shell rolls back its uncommitted transaction. */
  release(): Promise<void> {
    this.releasing ??= (async () => {
      this.child.stdin.end();
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 10_000);
      try {
        await this.closed;
      } finally {
        clearTimeout(timer);
      }
      if (this.error) throw this.error;
      if (this.child.exitCode !== 0) {
        throw new Error(`sqlite3 did not close cleanly: ${this.stderr}`);
      }
    })();
    return this.releasing;
  }
}
