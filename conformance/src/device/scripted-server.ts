import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import document from "../../../openapi.json" with { type: "json" };
import {
  answers,
  bulkGetOf,
  certifiedRead,
  SCRIPTED_READ_VIEW,
} from "./marfa-answers.js";

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

/** The response header every real answer names its contract version in. */
export const CONTRACT_HEADER = "X-Marfa-Contract";

/**
 * The contract the binary under test was generated for, read off the same
 * document, so the scripted answers speak it unless a fixture says otherwise.
 */
export const BUILT_FOR = document.info.version;

export interface SseFrame {
  /** A `:comment` line. The server sends one on connect and as a keepalive. */
  comment?: string;
  id?: string;
  event?: string;
  data?: unknown;
  /** The frame's text as it is, for one the server's own encoder never writes. */
  raw?: string;
}

export type Answer =
  | {
      kind: "json";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
      /**
       * The contract this one answer names, where it is not the server's:
       * `null` names none, as a proxy in front of the server answers, and a
       * list names it once per header line.
       */
      contract?: string | string[] | null;
    }
  | {
      kind: "sse";
      frames: SseFrame[];
      hold?: boolean;
      /** Held open with no keepalive: a server that has gone quiet. */
      quiet?: boolean;
    }
  /** Bytes as they are, which is what a blob's link serves. */
  | {
      kind: "bytes";
      status: number;
      body: Buffer;
      contentType?: string;
    }
  /** The connection dies mid-answer: what a device sees when a network goes. */
  | { kind: "drop" }
  /**
   * The request is accepted and never answered.
   *
   * A read that timed out, which `queue-and-verdicts/environmental-uncounted` names among the
   * environmental failures and which nothing else here produces: a drop is a
   * connection that died and a 5xx is an answer, and a device may
   * reasonably treat those two differently from a server that simply never
   * replies. It is also the only way to keep a device command running long
   * enough for a second one to meet it, which is what `device/reading-handle-refuses` is
   * about.
   */
  | { kind: "stall" }
  /** `then`, once `until` settles: an answer the fixture lets through when
   *  it chooses, so a second command can meet the first still running. */
  | { kind: "gated"; until: Promise<void>; then: Answer };

export interface RecordedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** The request target exactly as it arrived, before any parsing. */
  target: string;
  body: string;
  /** The body's bytes as they arrived, for a body that is not text. */
  raw: Buffer;
  /** Position in the whole run, so a fixture can assert one call preceded another. */
  seq: number;
}

export type Responder = Answer | ((request: RecordedRequest) => Answer);

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

/** What a door no fixture scripted answers. */
const NOT_SCRIPTED: Answer = {
  kind: "json",
  status: 501,
  body: {
    error: {
      code: "not_scripted",
      message: "no answer was scripted for this door",
    },
  },
  contract: null,
};

/** How often a held stream says something, well inside a device's idle bound. */
const KEEPALIVE_MS = 250;

function renderFrame(frame: SseFrame): string {
  if (frame.raw !== undefined) return frame.raw;
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
  /**
   * The contract every answer names unless it says otherwise. A fixture
   * sets it to script a server on another contract.
   */
  contract: string | null = BUILT_FOR;
  private recorded: RecordedRequest[] = [];
  private seq = 0;
  private unmatched: string[] = [];
  /** Keepalive timers for the streams still open, cleared when the server stops. */
  private held = new Set<NodeJS.Timeout>();
  /** Requests accepted and deliberately never answered. */
  private stalled = new Set<ServerResponse>();

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

  copyAnswer(
    method: string,
    pathname: string | RegExp,
    ...responders: Responder[]
  ): this {
    return this.answer(
      method,
      pathname,
      ...responders.map((responder) => (request: RecordedRequest) => {
        const answer =
          typeof responder === "function" ? responder(request) : responder;
        if (
          method !== "GET" ||
          request.headers["x-marfa-read-view"] !== SCRIPTED_READ_VIEW ||
          !/^\/(items(?:\/[^/]+(?:\/edges)?)?|edges(?:\/[^/]+)?|types|edge-types|keys\/current)$/.test(
            request.pathname,
          )
        )
          return answer;
        return certifiedRead(answer, BUILT_FOR);
      }),
    );
  }

  /**
   * Stop accepting connections, keeping the port. A device now meets a
   * refused connection, which is the failure class that retries forever.
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
    for (const keepalive of this.held) clearInterval(keepalive);
    this.held.clear();
    // Ended rather than left, or `server.close` waits on them and the
    // fixture's teardown hangs on a socket it opened on purpose.
    for (const response of this.stalled) response.destroy();
    this.stalled.clear();
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
        target: request.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
        raw: Buffer.concat(chunks),
        seq: this.seq++,
      };
      this.recorded.push(recorded);

      // Every real server answers its root, which `status` and `whoami`
      // read; a fixture that scripts no root gets the one naming the
      // server's contract.
      if (
        recorded.method === "GET" &&
        recorded.pathname === "/" &&
        !this.routes.some((candidate) => matches(candidate, "GET", "/"))
      ) {
        this.send(
          answers.root(
            this.contract === null ? undefined : Number(this.contract),
          ),
          response,
        );
        return;
      }
      this.send(this.respond(recorded) ?? NOT_SCRIPTED, response);
    });
  }

  /**
   * The next answer scripted for the request's door, or undefined where none
   * is, which is recorded as unmatched.
   *
   * A bulk read by id that no fixture scripted is answered from the reads by
   * id the fixture did script, one for each id in the order named, because
   * the server resolves each id as a read by id does: a fixture that scripts
   * a row's read scripts what a bulk read of it answers. The one difference
   * is a `system.*` row, which the bulk read leaves out unless its `include`
   * names `system` (`items/bulk-get-system`).
   */
  private respond(recorded: RecordedRequest): Answer | undefined {
    const route = this.routes.find((candidate) =>
      matches(candidate, recorded.method, recorded.pathname),
    );
    if (route) {
      const responder =
        route.responders.length > 1
          ? (route.responders.shift() as Responder)
          : route.responders[0];
      return typeof responder === "function" ? responder(recorded) : responder;
    }
    if (recorded.method === "POST" && recorded.pathname === "/items/bulk-get") {
      let ids: string[];
      let include: string[] | undefined;
      try {
        ({ ids, include } = JSON.parse(recorded.body) as {
          ids: string[];
          include?: string[];
        });
      } catch {
        return answers.validation("validation_error", "the body is not JSON");
      }
      const reads: Answer[] = [];
      for (const id of ids) {
        const read = this.respond({
          ...recorded,
          method: "GET",
          pathname: `/items/${id}`,
          query: new URLSearchParams({ include: "edges,metadata" }),
          target: `/items/${id}?include=edges,metadata`,
          body: "",
          raw: Buffer.alloc(0),
        });
        if (read === undefined) return NOT_SCRIPTED;
        reads.push(read);
      }
      return bulkGetOf(reads, {
        viewed: recorded.headers["x-marfa-read-view"] === SCRIPTED_READ_VIEW,
        system: include?.includes("system") ?? false,
      });
    }
    this.unmatched.push(`${recorded.method} ${recorded.pathname}`);
    return undefined;
  }

  private named(): Record<string, string> {
    return this.contract === null ? {} : { [CONTRACT_HEADER]: this.contract };
  }

  private send(answer: Answer, response: ServerResponse): void {
    if (answer.kind === "drop") {
      response.socket?.destroy();
      return;
    }
    if (answer.kind === "gated") {
      void answer.until.then(() => {
        this.send(answer.then, response);
      });
      return;
    }
    if (answer.kind === "stall") {
      // Nothing written and nothing ended. The socket stays open and the
      // device waits on it until its own bound says otherwise.
      this.stalled.add(response);
      response.on("close", () => this.stalled.delete(response));
      return;
    }
    if (answer.kind === "bytes") {
      response.writeHead(answer.status, {
        "content-type": answer.contentType ?? "application/octet-stream",
        "content-length": String(answer.body.length),
      });
      response.end(answer.body);
      return;
    }
    if (answer.kind === "json") {
      const body = JSON.stringify(answer.body);
      const named =
        answer.contract === undefined
          ? this.named()
          : answer.contract === null
            ? {}
            : { [CONTRACT_HEADER]: answer.contract };
      response.writeHead(answer.status, {
        "content-type": "application/json",
        ...named,
        ...answer.headers,
      });
      response.end(body);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...this.named(),
    });
    for (const frame of answer.frames) response.write(renderFrame(frame));
    // `hold` leaves the stream open, which is what a live subscription looks
    // like; a device reading one has to decide for itself that it has caught
    // up rather than waiting for the server to end the answer.
    if (!answer.hold) {
      response.end();
      return;
    }
    if (answer.quiet === true) {
      this.stalled.add(response);
      response.on("close", () => this.stalled.delete(response));
      return;
    }
    // Kept alive, because a live subscription is. A held stream that went
    // silent would be indistinguishable from a server that had stopped
    // answering, and a device with an idle bound ends the read — which
    // makes `hold` mean "open for a few seconds" rather than "open".
    const keepalive = setInterval(() => {
      response.write(renderFrame({ comment: "keepalive" }));
    }, KEEPALIVE_MS);
    keepalive.unref();
    this.held.add(keepalive);
    const stop = (): void => {
      clearInterval(keepalive);
      this.held.delete(keepalive);
    };
    response.on("close", stop);
    response.on("error", stop);
  }
}
