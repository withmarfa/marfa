import { spawn } from "node:child_process";

/**
 * The document asked for more than extraction may use, so it will not be
 * read under these limits however often it is tried. Anything else that
 * goes wrong is an ordinary `Error`, which the sweeper retries.
 */
export class ExtractionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionLimitError";
  }
}

const MEBIBYTE = 1024 * 1024;

/** Below this the process cannot load the parser at all (it fails near 8). */
const LEAST_HEAP_MB = 32;

/** What a process that answered wrote. */
interface Answer {
  text?: string;
  error?: string;
  limit?: boolean;
}

/** What one run of a program in a process of its own is given. */
export interface IsolatedRun {
  /** The program, as source for `node -e`. It reads the bytes on stdin, the
   *  options as JSON in `process.argv[1]`, and writes one JSON line:
   *  `{ text }`, or `{ error, limit }` where `limit` marks a refusal that no
   *  retry changes. */
  program: string;
  options: unknown;
  bytes: Buffer;
  /** The most the process's JavaScript heap may take. */
  maxMemoryBytes: number;
  /** The text the program may answer with, which bounds what it can say. */
  maxTextChars: number;
  /** Aborting kills the process, whatever it was doing. */
  signal?: AbortSignal;
}

/**
 * Runs a program over some bytes in a process of its own, with a capped heap
 * and a cap on what it may say, and answers its text.
 */
export function runIsolated(run: IsolatedRun): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (run.signal?.aborted) {
      reject(abortReason(run.signal));
      return;
    }
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${String(
          Math.max(LEAST_HEAP_MB, Math.ceil(run.maxMemoryBytes / MEBIBYTE)),
        )}`,
        "-e",
        run.program,
        JSON.stringify(run.options),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    // A cap on what the process may say, so a fault in it cannot fill this
    // one. What it writes is the text the server keeps, as JSON.
    const outputCap = run.maxTextChars * 6 + 4096;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let written = 0;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      run.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      settle();
    };
    const onAbort = () => {
      finish(() => {
        reject(abortReason(run.signal));
      });
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      written += chunk.length;
      if (written > outputCap) {
        finish(() => {
          reject(new Error("the extraction process wrote more than it may"));
        });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(err).length < 4096) err.push(chunk);
    });
    // The process can end before it has read its input.
    child.stdin.on("error", () => undefined);
    for (const pipe of [child.stdout, child.stderr]) {
      pipe.on("error", (error) => {
        finish(() => {
          reject(error);
        });
      });
    }
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", (code, killedBy) => {
      finish(() => {
        const said = Buffer.concat(out).toString("utf8");
        if (said.length > 0) {
          let answer: Answer;
          try {
            answer = JSON.parse(said) as Answer;
          } catch {
            reject(new Error("the extraction process gave no usable answer"));
            return;
          }
          if (answer.error === undefined) resolve(answer.text ?? "");
          else if (answer.limit) reject(new ExtractionLimitError(answer.error));
          else reject(new Error(answer.error));
          return;
        }
        // V8 ends the process when its heap is full, and says so on stderr.
        if (
          /heap out of memory|Allocation failed/i.test(
            Buffer.concat(err).toString("utf8"),
          )
        ) {
          reject(
            new ExtractionLimitError(
              "the document needs more memory than extraction may use",
            ),
          );
          return;
        }
        reject(
          new Error(
            `the extraction process ended with ${
              killedBy ?? `code ${String(code)}`
            }`,
          ),
        );
      });
    });
    child.stdin.end(run.bytes);
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("extraction was stopped");
}
