import { fork, type ChildProcess } from "node:child_process";

export interface ChildMessage {
  kind: string;
  url?: string;
  written?: number;
}

/**
 * How long a forked fixture has to report ready. A cold run compiles the
 * fixture and everything it imports through tsx while the other test
 * processes are using the CPUs, which takes far longer than a warm start.
 */
export const READY_BUDGET_MS = 60_000;

const KEPT_OUTPUT_BYTES = 8_192;

interface Tracked {
  output: () => string;
  /** Settles, never rejects, with why the child is gone. */
  gone: Promise<string>;
}

const tracked = new WeakMap<ChildProcess, Tracked>();

/**
 * Forks a fixture through tsx with its output passed on to this process and
 * the end of its output kept, so a failed wait can say what the child said.
 */
export function forkFixture(file: URL | string): ChildProcess {
  const child = fork(file, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  const keep = (data: Buffer) => {
    output = (output + data.toString()).slice(-KEPT_OUTPUT_BYTES);
  };
  child.stdout?.on("data", (data: Buffer) => {
    keep(data);
    process.stdout.write(data);
  });
  child.stderr?.on("data", (data: Buffer) => {
    keep(data);
    process.stderr.write(data);
  });
  const gone = new Promise<string>((resolve) => {
    // "close" follows "exit" once the output has been read to its end.
    child.once("close", (code, signal) => {
      resolve(
        signal === null
          ? `exited with code ${String(code)}`
          : `was killed by signal ${signal}`,
      );
    });
    child.once("error", (err) => {
      resolve(`failed: ${err.message}`);
    });
  });
  tracked.set(child, { output: () => output, gone });
  return child;
}

/**
 * Resolves with the child's next message of `kind`. Rejects when the child
 * exits, is killed or fails first, naming the code or signal and what it
 * wrote to its output, and when the budget runs out.
 */
export function nextMessage(
  child: ChildProcess,
  kind: string,
  budgetMs = READY_BUDGET_MS,
): Promise<ChildMessage> {
  const state = tracked.get(child);
  if (!state) throw new Error("child was not started by forkFixture");
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      child.off("message", receive);
    };
    const timer = setTimeout(() => {
      done();
      reject(
        new Error(
          `child did not report ${kind} within ${String(budgetMs)} ms${withOutput(state)}`,
        ),
      );
    }, budgetMs);
    const receive = (message: ChildMessage) => {
      if (message.kind !== kind) return;
      done();
      resolve(message);
    };
    child.on("message", receive);
    void state.gone.then((why) => {
      done();
      reject(
        new Error(
          `child ${why} before it reported ${kind}${withOutput(state)}`,
        ),
      );
    });
  });
}

function withOutput(state: Tracked): string {
  const output = state.output().trim();
  return output ? `\nchild output:\n${output}` : "\nchild output: none";
}
