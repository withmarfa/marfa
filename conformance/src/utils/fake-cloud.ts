import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { waitFor } from "./wait.js";

/**
 * A stand-in for Marfa Cloud's link API, on loopback, for a server booted
 * with `MARFA_CLOUD_URL` at its `url`.
 *
 * It answers `POST /link/start`, `POST /link/poll`, `POST /link/cancel`,
 * `GET /link`, `POST /link/token` and `POST /link/unlink` as Marfa Cloud
 * does, records
 * every request it is sent, and is driven by the test through its methods
 * or, when it runs on its own, through `POST /_fake/<action>`:
 *
 * - `approve`, `deny`, `expire` and `refuse` decide the latest link. An
 *   approval with `ready: false` answers `pending` until `ready`, as Marfa
 *   Cloud does while it readies the name.
 * - `slow_down` answers the next poll with `slow_down` and a new interval.
 * - `lose_next_approved` makes a credential for the next `approved` answer
 *   and drops the connection before the answer is sent.
 * - `forget` makes Cloud forget the latest link, as an unlink on the Marfa
 *   Cloud account page does.
 * - `answer_next_use` answers the next request made with a link credential
 *   with the `status` and error `code` given, and leaves the credential unused.
 * - `fail_cancels` answers every cancel `500` until `up`.
 * - `rotate_token` gives the latest link a new tunnel token, which `POST
 *   /link/token` answers from then on, as Marfa Cloud does when it rotates it.
 * - `fail_token_read` answers the next `POST /link/token` with `503
 *   unavailable` and `Retry-After: 60`, as Marfa Cloud does when Cloudflare
 *   does not answer. The read counts against the link's token limit.
 * - `down` and `up` stop and start answering the link API.
 *
 * It holds the limits Marfa Cloud documents: each route answers `429
 * rate_limited` with `Retry-After: 60` past 60 requests a minute from one IP
 * address, and each link reads its tunnel token once a minute (`POST
 * /link/token`): the first read answers at once and another within the
 * minute answers `429 rate_limited` with `Retry-After` set to the seconds
 * left, `tokenIntervalMs` being the minute. Every answer carries
 * `cache-control: no-store`, and a `401` carries `WWW-Authenticate: Bearer`.
 * A `POST` without `content-type: application/json` answers `415
 * unsupported_media_type`, and a body past 8 KB `413 too_large`.
 *
 * Each `approved` answer before the first use of a credential makes a new
 * credential that replaces the last, so only the latest works, and once it
 * is used the poll secret stops working. An approved link is answered for
 * ten minutes after its approval, even past its expiry. A start answers how
 * long the link waits as `expires_in`, in seconds, as RFC 8628 does.
 *
 * On its own: `tsx src/utils/fake-cloud.ts --port <port>`.
 */
export interface FakeCloud {
  /** The origin to give `MARFA_CLOUD_URL`. */
  url: string;
  /** Every request to the link API, in the order it came. */
  requests: Recorded[];
  /** The links started, oldest first. */
  links: FakeLink[];
  latest(): FakeLink;
  approve(decided?: { name?: string; address?: string; ready?: boolean }): void;
  ready(): void;
  deny(): void;
  expire(): void;
  refuse(message?: string): void;
  slowDown(interval: number): void;
  loseNextApproved(): void;
  forget(): void;
  answerNextUse(status: number, code: string): void;
  failCancels(): void;
  failNextTokenRead(): void;
  /** Gives the latest link a new tunnel token and returns it. */
  rotateToken(): string;
  down(): void;
  up(): void;
  /** Waits until the link API has been sent `count` requests to `path`. */
  waitFor(path: string, count?: number, timeoutMs?: number): Promise<void>;
  /** What `GET /link` answers to `credential`, without counting it as a use. */
  answers(credential: string): number;
  close(): Promise<void>;
}

export interface Recorded {
  method: string;
  path: string;
  body: any;
  authorization: string | null;
  at: number;
}

export interface FakeLink {
  linkId: string;
  pollSecret: string;
  userCode: string;
  approvalUrl: string;
  expiresAt: number;
  interval: number;
  originPort: number;
  instanceId: string;
  instanceName: string | null;
  decision: "pending" | "approved" | "denied" | "refused";
  /** When it was approved, if it was. */
  approvedAt: number | null;
  /** `false` while an approval is answered as `pending`. */
  ready: boolean;
  refusedMessage: string;
  name: string;
  address: string;
  linkedAt: string;
  tunnelToken: string;
  /** Every credential made for the link; only the last works. */
  credentials: string[];
  used: boolean;
  unlinked: boolean;
  /** Ended by `POST /link/cancel`. */
  canceled: boolean;
  /** When the link's tunnel token was last read, if it was. */
  tokenReadAt: number | null;
  /** Polls that came sooner than the interval the last answer gave. */
  tooSoon: number;
  lastPoll: number | null;
  /** The interval the next poll answers with `slow_down`, if one is set. */
  slowDownTo: number | null;
  /** When the last `slow_down` answer was sent. */
  slowedAt: number | null;
}

export interface FakeCloudOptions {
  port?: number;
  /** Seconds between polls the start and each `pending` answer give. */
  interval?: number;
  /** How long a link waits for approval, a whole number of seconds. */
  lifetimeMs?: number;
  /** The time between two reads of a link's tunnel token; Marfa Cloud's is a minute. */
  tokenIntervalMs?: number;
}

/** How long past its approval an approved link is answered, even past `expires_at`. */
const APPROVED_FOR_MS = 600_000;

/** A poll this much sooner than the interval is still in time. */
const POLL_GRACE_MS = 1_000;

/** Marfa Cloud's limit on each route from one IP address, and the minute it counts in. */
const ROUTE_LIMIT = 60;
const ROUTE_WINDOW_MS = 60_000;
const MOST_BODY_BYTES = 8 * 1024;
/** The user code's alphabet: no vowel, so a code never spells a word. */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

export async function fakeCloud(
  options: FakeCloudOptions = {},
): Promise<FakeCloud> {
  const interval = options.interval ?? 1;
  const lifetimeMs = options.lifetimeMs ?? 600_000;
  const tokenIntervalMs = options.tokenIntervalMs ?? 60_000;
  const requests: Recorded[] = [];
  const links: FakeLink[] = [];
  let unreachable = false;
  let loseApproved = false;
  let cancelsFail = false;
  let tokenReadFails = false;
  const windows = new Map<string, { from: number; count: number }>();
  let nextUse: { status: number; code: string } | null = null;

  const latest = (): FakeLink => {
    const link = links.at(-1);
    if (link === undefined) throw new Error("no link has been started");
    return link;
  };
  const secret = (): string => randomBytes(24).toString("base64url");
  const byCredential = (authorization: string | null) => {
    const credential = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    return links.find(
      (link) =>
        !link.unlinked &&
        credential !== undefined &&
        link.credentials.at(-1) === credential,
    );
  };

  const control: Record<string, (body: any) => void> = {
    approve: (body) => decide("approved", body ?? undefined),
    ready: () => {
      latest().ready = true;
    },
    deny: () => decide("denied"),
    expire: () => {
      latest().expiresAt = Date.now() - 1;
    },
    refuse: (body) => {
      decide("refused");
      latest().refusedMessage =
        body?.message ?? "This account already has an instance linked.";
    },
    slow_down: (body) => {
      latest().slowDownTo = Number(body?.interval ?? interval * 2);
    },
    lose_next_approved: () => {
      loseApproved = true;
    },
    forget: () => {
      latest().unlinked = true;
    },
    answer_next_use: (body) => {
      nextUse = { status: Number(body?.status), code: String(body?.code) };
    },
    fail_cancels: () => {
      cancelsFail = true;
    },
    fail_token_read: () => {
      tokenReadFails = true;
    },
    rotate_token: () => {
      latest().tunnelToken = `tunnel-${secret()}`;
    },
    down: () => {
      unreachable = true;
    },
    up: () => {
      unreachable = false;
      cancelsFail = false;
    },
  };

  function decide(
    decision: FakeLink["decision"],
    decided: { name?: string; address?: string; ready?: boolean } = {},
  ): void {
    const link = latest();
    link.decision = decision;
    if (decision === "approved") {
      link.name =
        decided.name ?? `test-${link.userCode.slice(0, 4).toLowerCase()}`;
      link.address =
        decided.address ?? `http://127.0.0.1:${String(link.originPort)}`;
      link.linkedAt = new Date().toISOString();
      link.approvedAt = Date.now();
      link.ready = decided.ready ?? true;
    }
  }

  function poll(body: any, response: ServerResponse): void {
    const link = links.find(
      (each) =>
        each.linkId === body?.link_id && each.pollSecret === body?.poll_secret,
    );
    if (link === undefined || link.used || link.unlinked) {
      return error(
        response,
        404,
        "link_not_found",
        "No link has this ID and secret.",
      );
    }
    const now = Date.now();
    const soon =
      link.lastPoll !== null &&
      now - link.lastPoll < link.interval * 1000 - POLL_GRACE_MS;
    link.lastPoll = now;
    if (soon) link.tooSoon += 1;
    if (link.slowDownTo !== null || soon) {
      link.interval = link.slowDownTo ?? link.interval + 1;
      link.slowDownTo = null;
      link.slowedAt = now;
      return json(response, 200, {
        status: "slow_down",
        interval: link.interval,
      });
    }
    if (link.decision === "denied")
      return json(response, 200, { status: "denied" });
    if (link.decision === "refused") {
      return json(response, 200, {
        status: "refused",
        reason: "account_has_instance",
        message: link.refusedMessage,
      });
    }
    const late =
      link.approvedAt !== null && now < link.approvedAt + APPROVED_FOR_MS;
    if (now >= link.expiresAt && !late)
      return json(response, 200, { status: "expired" });
    if (link.decision === "pending" || !link.ready) {
      return json(response, 200, {
        status: "pending",
        interval: link.interval,
      });
    }
    const credential = secret();
    link.credentials.push(credential);
    if (loseApproved) {
      loseApproved = false;
      response.socket?.destroy();
      return;
    }
    json(response, 200, {
      status: "approved",
      name: link.name,
      address: link.address,
      tunnel_token: link.tunnelToken,
      link_credential: credential,
    });
  }

  function cancel(body: any, response: ServerResponse): void {
    if (cancelsFail) {
      return error(response, 500, "internal_error", "Something went wrong.");
    }
    const link = links.find(
      (each) =>
        each.linkId === body?.link_id && each.pollSecret === body?.poll_secret,
    );
    if (link === undefined || link.used || link.unlinked) {
      return error(
        response,
        404,
        "link_not_found",
        "No link has this ID and secret.",
      );
    }
    link.unlinked = true;
    link.canceled = true;
    json(response, 200, { cancelled: true });
  }

  function start(body: any, response: ServerResponse): void {
    const letters = Array.from(
      randomBytes(8),
      (byte) => CODE_LETTERS[byte % CODE_LETTERS.length]!,
    ).join("");
    const userCode = `${letters.slice(0, 4)}-${letters.slice(4)}`;
    const link: FakeLink = {
      linkId: randomUUID(),
      pollSecret: secret(),
      userCode,
      approvalUrl: `${url}/link/${userCode}`,
      expiresAt: Date.now() + lifetimeMs,
      interval,
      originPort: Number(body?.origin_port),
      instanceId: String(body?.instance_id),
      instanceName: body?.instance_name ?? null,
      decision: "pending",
      approvedAt: null,
      ready: true,
      refusedMessage: "",
      name: "",
      address: "",
      linkedAt: "",
      tunnelToken: `tunnel-${secret()}`,
      credentials: [],
      used: false,
      unlinked: false,
      canceled: false,
      tokenReadAt: null,
      tooSoon: 0,
      lastPoll: null,
      slowDownTo: null,
      slowedAt: null,
    };
    links.push(link);
    json(response, 201, {
      link_id: link.linkId,
      poll_secret: link.pollSecret,
      user_code: link.userCode,
      approval_url: link.approvalUrl,
      expires_at: new Date(link.expiresAt).toISOString(),
      expires_in: Math.round(lifetimeMs / 1000),
      interval: link.interval,
    });
  }

  function credentialed(request: Recorded, response: ServerResponse): void {
    if (nextUse !== null) {
      const { status, code } = nextUse;
      nextUse = null;
      return error(
        response,
        status,
        code,
        "The fake Cloud was told to refuse this use.",
      );
    }
    const link = byCredential(request.authorization);
    if (link === undefined) {
      return error(
        response,
        401,
        "unauthorized",
        "The link credential is not known.",
        { "www-authenticate": "Bearer" },
      );
    }
    if (request.path === "/link/token") {
      const now = Date.now();
      const waited = link.tokenReadAt === null ? null : now - link.tokenReadAt;
      if (waited !== null && waited < tokenIntervalMs) {
        return error(
          response,
          429,
          "rate_limited",
          "This link read its tunnel token a moment ago.",
          {
            "retry-after": String(Math.ceil((tokenIntervalMs - waited) / 1000)),
          },
        );
      }
      link.tokenReadAt = now;
      if (tokenReadFails) {
        tokenReadFails = false;
        return error(response, 503, "unavailable", "Try again shortly.", {
          "retry-after": "60",
        });
      }
      link.used = true;
      return json(response, 200, { tunnel_token: link.tunnelToken });
    }
    link.used = true;
    if (request.method === "GET" && request.path === "/link") {
      return json(response, 200, {
        name: link.name,
        address: link.address,
        linked_at: link.linkedAt,
      });
    }
    link.unlinked = true;
    json(response, 200, { unlinked: true });
  }

  /** Counts a request against its route's minute, and says whether it is past the limit. */
  function overLimit(route: string): boolean {
    const now = Date.now();
    const held = windows.get(route);
    if (held === undefined || now - held.from >= ROUTE_WINDOW_MS) {
      windows.set(route, { from: now, count: 1 });
      return false;
    }
    held.count += 1;
    return held.count > ROUTE_LIMIT;
  }

  const server = createServer((incoming, response) => {
    void read(incoming).then((text) => {
      const path = new URL(incoming.url ?? "/", "http://fake").pathname;
      const action = /^\/_fake\/([a-z_]+)$/.exec(path)?.[1];
      let body: any = null;
      const driven = action !== undefined && incoming.method === "POST";
      if (!driven && unreachable) {
        response.socket?.destroy();
        return;
      }
      if (!driven && overLimit(`${incoming.method ?? ""} ${path}`)) {
        return error(
          response,
          429,
          "rate_limited",
          "Too many requests from this address.",
          { "retry-after": "60" },
        );
      }
      if (!driven && incoming.method === "POST") {
        if (
          !/^application\/json\b/i.test(incoming.headers["content-type"] ?? "")
        ) {
          return error(
            response,
            415,
            "unsupported_media_type",
            "Send content-type: application/json.",
          );
        }
        if (Buffer.byteLength(text) > MOST_BODY_BYTES) {
          return error(response, 413, "too_large", "The body is too large.");
        }
      }
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        return error(response, 400, "invalid_request", "The body is not JSON.");
      }
      if (driven) {
        const act = control[action];
        if (act === undefined)
          return error(response, 404, "not_found", "No such action.");
        act(body);
        return json(response, 200, { ok: true });
      }
      const recorded: Recorded = {
        method: incoming.method ?? "",
        path,
        body,
        authorization: incoming.headers.authorization ?? null,
        at: Date.now(),
      };
      requests.push(recorded);
      const route = `${recorded.method} ${path}`;
      if (route === "POST /link/start") return start(body, response);
      if (route === "POST /link/poll") return poll(body, response);
      if (route === "POST /link/cancel") return cancel(body, response);
      if (
        route === "GET /link" ||
        route === "POST /link/token" ||
        route === "POST /link/unlink"
      ) {
        return credentialed(recorded, response);
      }
      error(response, 404, "not_found", "Nothing is here.");
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const bound = server.address();
  if (typeof bound !== "object" || bound === null) {
    throw new Error("the fake Cloud did not bind to a port");
  }
  const url = `http://127.0.0.1:${String(bound.port)}`;

  return {
    url,
    requests,
    links,
    latest,
    approve: (decided) => control.approve!(decided),
    ready: () => control.ready!(null),
    deny: () => control.deny!(null),
    expire: () => control.expire!(null),
    refuse: (message) => control.refuse!({ message }),
    slowDown: (to) => control.slow_down!({ interval: to }),
    loseNextApproved: () => control.lose_next_approved!(null),
    forget: () => control.forget!(null),
    answerNextUse: (status, code) => control.answer_next_use!({ status, code }),
    failCancels: () => control.fail_cancels!(null),
    failNextTokenRead: () => control.fail_token_read!(null),
    rotateToken: () => {
      control.rotate_token!(null);
      return latest().tunnelToken;
    },
    down: () => control.down!(null),
    up: () => control.up!(null),
    async waitFor(path, count = 1, timeoutMs = 30_000) {
      await waitFor(
        `${String(count)} requests to ${path} at the fake Cloud`,
        async () =>
          requests.filter((each) => each.path === path).length >= count
            ? true
            : undefined,
        timeoutMs,
      );
    },
    answers(credential) {
      const link = byCredential(`Bearer ${credential}`);
      return link === undefined ? 401 : 200;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function read(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      text += chunk;
    });
    incoming.on("end", () => resolve(text));
  });
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    })
    .end(JSON.stringify(body));
}

function error(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  json(response, status, { error: { code, message } }, headers);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--port");
  const port = at === -1 ? 0 : Number(process.argv[at + 1]);
  const cloud = await fakeCloud({ port });
  process.stdout.write(`The fake Marfa Cloud is at ${cloud.url}\n`);
}
