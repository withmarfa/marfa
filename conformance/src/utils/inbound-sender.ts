import { request as httpRequest, type ClientRequest } from "node:http";

/** What a sender reads back from a receipt. */
export interface RawAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function answerOf(
  res: import("node:http").IncomingMessage,
  done: (answer: RawAnswer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () =>
    done({
      status: res.statusCode ?? 0,
      headers: res.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }),
  );
}

function target(base: string, path: string) {
  const url = new URL(path, base);
  return {
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    host: url.host,
  };
}

/**
 * A sender's request, written by hand: the headers go out in the order and
 * case given, repeats kept, and no credential is added. `Host` and
 * `Content-Length` are the target's and the body's own unless `headers` names
 * them.
 */
export function send(
  base: string,
  path: string,
  body: Buffer | string,
  headers: string[] = [],
): Promise<RawAnswer> {
  const to = target(base, path);
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const names = (name: string) =>
    headers.some(
      (header, index) => index % 2 === 0 && header.toLowerCase() === name,
    );
  const named = names("content-length");
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: "POST",
        hostname: to.hostname,
        port: to.port,
        path: to.path,
        headers: [
          ...(names("host") ? [] : ["Host", to.host]),
          ...headers,
          ...(named ? [] : ["Content-Length", String(bytes.length)]),
        ],
      },
      (res) => answerOf(res, resolve),
    );
    req.on("error", reject);
    req.end(bytes);
  });
}

/**
 * A request whose body is sent in chunks with no length declared, so the
 * server learns the size only by reading it.
 */
export function sendChunked(
  base: string,
  path: string,
  chunks: Buffer[],
): Promise<RawAnswer> {
  const to = target(base, path);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: "POST",
        hostname: to.hostname,
        port: to.port,
        path: to.path,
        headers: ["Host", to.host, "Transfer-Encoding", "chunked"],
      },
      (res) => answerOf(res, resolve),
    );
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

/** A body that has begun and not ended: the headers and the first bytes are
 *  out, and the rest is the fixture's to send or to abandon. */
export interface OpenBody {
  /** What the server answered, once it did. */
  answer: Promise<RawAnswer>;
  /** Sends the rest of the body and ends the request. */
  finish(rest: Buffer | string): void;
  /** Drops the connection with the body unfinished. */
  abandon(): void;
}

/**
 * Declares `declared` bytes, sends `first` of them and goes quiet. The
 * server's answer, if it gives one before the body ends, is in `answer`.
 */
export function openBody(
  base: string,
  path: string,
  declared: number,
  first: Buffer | string,
): OpenBody {
  const to = target(base, path);
  let request: ClientRequest | undefined;
  const answer = new Promise<RawAnswer>((resolve, reject) => {
    request = httpRequest(
      {
        method: "POST",
        hostname: to.hostname,
        port: to.port,
        path: to.path,
        headers: ["Host", to.host, "Content-Length", String(declared)],
      },
      (res) => answerOf(res, resolve),
    );
    request.on("error", (error) => {
      // A request dropped on purpose ends in a reset, which is its answer.
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") {
        resolve({ status: 0, headers: {}, body: "" });
      } else {
        reject(error);
      }
    });
    request.flushHeaders();
    if (first.length > 0) request.write(first);
  });
  return {
    answer,
    finish(rest) {
      request?.end(rest);
    },
    abandon() {
      request?.destroy();
    },
  };
}

/**
 * What the server answers to a body that is declared and then left unsent,
 * or sent in part: its answer, with the connection dropped once it came.
 */
export async function answerToUnfinished(
  base: string,
  path: string,
  declared: number,
  first: Buffer | string = "",
): Promise<RawAnswer> {
  const open = openBody(base, path, declared, first);
  try {
    return await open.answer;
  } finally {
    open.abandon();
  }
}

export function codeOf(answer: RawAnswer): string | undefined {
  return (JSON.parse(answer.body) as { error?: { code?: string } }).error?.code;
}

export function idOf(answer: RawAnswer): string {
  if (answer.status !== 202) {
    throw new Error(`a receipt answered ${String(answer.status)}`);
  }
  return (JSON.parse(answer.body) as { id: string }).id;
}
