import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A server the fixture writes the answers for.
 *
 * The device chapters need verdicts the real server cannot be asked for — a
 * dropped connection, a server at rest, a spent credential, a refusal repeated
 * until a ceiling. Every one of those is a statement about the environment or
 * about a credential's history rather than about a request, and the API offers
 * no door that produces one. So the fixtures script the answers instead, and
 * `fidelity.test.ts` holds the scripting to what the real server does for
 * every case the real server can produce.
 */

export interface SseFrame {
  /** A `:comment` line. The server sends one on connect and as a keepalive. */
  comment?: string;
  id?: string;
  event?: string;
  data?: unknown;
}

export type Answer =
  | {
      kind: "json";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    }
  | { kind: "sse"; frames: SseFrame[]; hold?: boolean }
  /** The connection dies mid-answer: what a device sees when a network goes. */
  | { kind: "drop" };

export interface RecordedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
  /** Position in the whole run, so a fixture can assert one call preceded another. */
  seq: number;
}

type Responder = Answer | ((request: RecordedRequest) => Answer);

interface Route {
  method: string;
  pathname: string | RegExp;
  /** Consumed in order; the last one answers every call after it. */
  responders: Responder[];
}

function matches(route: Route, method: string, pathname: string): boolean {
  if (route.method !== method) return false;
  return typeof route.pathname === "string"
    ? route.pathname === pathname
    : route.pathname.test(pathname);
}

function renderFrame(frame: SseFrame): string {
  if (frame.comment !== undefined) return `: ${frame.comment}\n\n`;
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data ?? {})}`);
  return `${lines.join("\n")}\n\n`;
}

export class ScriptedServer {
  private constructor(
    private server: Server,
    readonly port: number,
  ) {}

  private routes: Route[] = [];
  private recorded: RecordedRequest[] = [];
  private seq = 0;
  private unmatched: string[] = [];

  static async start(): Promise<ScriptedServer> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    const scripted = new ScriptedServer(server, port);
    server.on("request", (request, response) => {
      scripted.handle(request, response);
    });
    return scripted;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /** Every request the server has seen, in order. */
  get requests(): readonly RecordedRequest[] {
    return this.recorded;
  }

  /**
   * Requests no route claimed. A fixture asserts this is empty rather than
   * reading a 501 out of the device's error text, because a device that
   * called a door the script never wrote is a device doing something the
   * fixture is not testing.
   */
  get unmatchedRequests(): readonly string[] {
    return this.unmatched;
  }

  /**
   * Queue answers for a door. A second call for the same door appends rather
   * than shadowing: a route the first call already claimed would never be
   * reached, and the fixture would be reading the first script's answers
   * while believing it had written new ones.
   */
  answer(
    method: string,
    pathname: string | RegExp,
    ...responders: Responder[]
  ): this {
    const existing = this.routes.find(
      (route) =>
        route.method === method && String(route.pathname) === String(pathname),
    );
    if (existing) existing.responders.push(...responders);
    else this.routes.push({ method, pathname, responders });
    return this;
  }

  /**
   * Stop accepting connections, keeping the port. A device now meets a
   * refused connection, which is the failure class that retries for ever.
   */
  async offline(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Accept again on the same port. */
  async online(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", this.url);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      const recorded: RecordedRequest = {
        method: request.method ?? "GET",
        pathname: url.pathname,
        query: url.searchParams,
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
        seq: this.seq++,
      };
      this.recorded.push(recorded);

      const route = this.routes.find((candidate) =>
        matches(candidate, recorded.method, recorded.pathname),
      );
      if (!route) {
        this.unmatched.push(`${recorded.method} ${recorded.pathname}`);
        response.writeHead(501, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "not_scripted",
              message: "no answer was scripted for this door",
            },
          }),
        );
        return;
      }

      const responder =
        route.responders.length > 1
          ? (route.responders.shift() as Responder)
          : route.responders[0];
      const answer =
        typeof responder === "function" ? responder(recorded) : responder;
      this.send(answer, response);
    });
  }

  private send(answer: Answer, response: ServerResponse): void {
    if (answer.kind === "drop") {
      response.socket?.destroy();
      return;
    }
    if (answer.kind === "json") {
      const body = JSON.stringify(answer.body);
      response.writeHead(answer.status, {
        "content-type": "application/json",
        ...answer.headers,
      });
      response.end(body);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const frame of answer.frames) response.write(renderFrame(frame));
    // `hold` leaves the stream open, which is what a live subscription looks
    // like; a device reading one has to decide for itself that it has caught
    // up rather than waiting for the server to end the answer.
    if (!answer.hold) response.end();
  }
}
