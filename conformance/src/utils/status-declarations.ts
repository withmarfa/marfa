/**
 * Hold every status the server was observed answering to the statuses its
 * document declares for that operation.
 *
 * The observation is the server's own request log rather than a client's,
 * because the fixtures reach the server four ways — the typed client, bare
 * `fetch`, and the binary in each of two suites — and only the server sees
 * all four.
 *
 * Pure, so `status-declarations.test.ts` can show it a log naming an
 * undeclared status; `scripts/check-statuses.ts` is the shell that reads a
 * real log and a real document into it.
 */

/** One request as `middleware/logger.ts` writes it. */
export interface RequestLine {
  method: string;
  /** The route template, in the document's spelling: `/items/{id}`. */
  route: string;
  /** The concrete path, which is what resolves a wildcard route. */
  path: string;
  status: number;
  /** `X-Error-Code`, present on a refusal the error handler rendered. */
  code: string | undefined;
}

/** A status a published operation answered and does not declare. */
export interface UndeclaredStatus {
  operation: string;
  status: number;
  /** The refusal codes seen on it, which is what the declaration needs. */
  codes: string[];
  declared: number[];
}

export interface StatusReport {
  /** Published operations, each with the statuses and codes observed. */
  observed: Map<string, Map<number, Set<string>>>;
  /** Routes the server served that the document does not publish. */
  unpublished: Map<string, Set<number>>;
  /**
   * Of those, the ones not named in {@link UNPUBLISHED_ROUTES}: a door the
   * server serves and neither publishes nor says why.
   */
  unexplained: string[];
  undeclared: UndeclaredStatus[];
  /**
   * Declared statuses no request drew, by operation, less the ones the
   * harness cannot reach by construction. Only meaningful over a run that
   * reaches every door; see {@link unreachedDebt}.
   */
  unanswered: string[];
  /** Request lines read, so an empty log cannot read as a clean run. */
  lines: number;
}

const HTTP_METHODS = ["get", "head", "post", "put", "patch", "delete"];

/**
 * The routes the server serves outside its document, each with why. A route
 * served and missing from here is reported, so the document cannot lose a
 * door into this bucket without somebody writing the reason down.
 */
export const UNPUBLISHED_ROUTES: Readonly<Record<string, string>> = {
  "GET /": "names the instance, its build and the surfaces it serves",
  "GET /health": "liveness, read before any credential exists",
  "GET /openapi.json": "the document itself",
  "GET /metrics": "server metrics, internal",
  "GET /blobs/{hash}/fetch":
    "the target of an instance-served blob link, gated by the signature in its query",
  "GET /.well-known/oauth-authorization-server/auth": "RFC 8414 discovery",
  "GET /.well-known/openid-configuration/auth": "OIDC discovery",
  "GET /auth/.well-known/oauth-authorization-server":
    "the issuer-suffixed spelling of the same document",
  "GET /auth/.well-known/openid-configuration": "and of the OIDC one",
  "GET /.well-known/oauth-protected-resource":
    "RFC 9728 resource metadata, which a bearer challenge points at",
  "GET /auth/sign-in": "the sign-in page",
  "POST /auth/sign-in": "its form post",
  "GET /auth/authorize": "the consent screen",
  "POST /auth/authorize/decision": "its decision",
  "GET /auth/device": "the device-code entry page",
  "POST /auth/device": "its form post",
  "GET /auth/device/consent": "the device consent screen",
  "POST /auth/device/consent": "its decision",
  "GET /auth/error": "the OAuth failure page a redirect lands on",
  "GET /auth/oauth2/end-session": "the RP-initiated logout page",
  "GET /auth/static/auth.css": "a stylesheet those pages load",
  "GET /auth/static/password-toggle.js": "a script those pages load",
  "GET /auth/*":
    "the sign-in library's own endpoints, a browser's and an OAuth client's rather than an API caller's",
  "POST /auth/*":
    "the same; the one door under it the document publishes, client registration, is resolved by its path",
};

/**
 * Statuses every door declares that no fixture can draw from the harness's
 * server. `429` is the limiter, which `marfa:up` boots with rate limiting
 * off so a full suite does not throttle itself. `413` is the body cap, which
 * each capped door declares from the chain; a fixture draws it on the doors
 * whose own chapter says what it means there.
 */
export const HARNESS_UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([
  413, 429,
]);

/**
 * Declared statuses on a door's own account that no fixture draws, each with
 * why. The list is the size of what the document says and nothing asserts:
 * a run that draws one of these reports the entry as stale, and a run that
 * leaves a declaration undrawn and unlisted fails.
 */
const IN_FLIGHT = "a second request under a key whose first is still being written; a local write finishes before a second request can land, so only a race draws it";

export const UNREACHED: Readonly<Record<string, string>> = {
  "DELETE /admin/platform-types/{id} 200":
    "removes a row an earlier build shipped and this one does not; the harness boots one build, so no such row exists",
  "DELETE /edges/{id} 409": IN_FLIGHT,
  "DELETE /items/{id} 409": IN_FLIGHT,
  "DELETE /items/{id}/purge 409": IN_FLIGHT,
  "POST /items/{id}/restore 409": IN_FLIGHT,
  "POST /items/{id}/transition 409": IN_FLIGHT,
  "GET /types/{id} 409":
    "a stored inheritance chain with a cycle or past the depth limit, which the type doors refuse to write; only a store written outside the server carries one",
  "POST /connectors 403":
    "a session token, which only a person signing in through the browser flow holds",
  "POST /housekeeping/{name}/run 409":
    "a run already holding the job; a local run finishes before a second request can land",
};

/**
 * The request lines in a server log, which also carries startup and failure
 * lines and whatever a dependency wrote to stdout. A line that is not a
 * request record is skipped: this reads the stream, it does not own it.
 */
export function parseRequestLines(log: string): RequestLine[] {
  const out: RequestLine[] = [];
  for (const raw of log.split("\n")) {
    const text = raw.trim();
    if (text === "" || !text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const line = parsed as Record<string, unknown>;
    if (
      typeof line.method !== "string" ||
      typeof line.route !== "string" ||
      typeof line.path !== "string" ||
      typeof line.status !== "number"
    ) {
      continue;
    }
    out.push({
      method: line.method.toUpperCase(),
      route: line.route,
      path: line.path,
      status: line.status,
      code: typeof line.error_code === "string" ? line.error_code : undefined,
    });
  }
  return out;
}

export interface OpenApiLike {
  paths?: Record<string, Record<string, unknown>>;
}

/** `METHOD /path` to the statuses the document declares for it. */
export function declaredStatuses(
  document: OpenApiLike,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      // A path item also carries `parameters` and `summary`, which are not
      // operations.
      if (!HTTP_METHODS.includes(method)) continue;
      const responses = (operation as { responses?: Record<string, unknown> })
        .responses;
      const statuses = new Set<number>();
      for (const key of Object.keys(responses ?? {})) {
        const status = Number.parseInt(key, 10);
        if (Number.isInteger(status)) statuses.add(status);
      }
      out.set(`${method.toUpperCase()} ${path}`, statuses);
    }
  }
  return out;
}

/**
 * A route the document does not publish is counted rather than refused: the
 * sign-in pages, `/health` and the document itself are outside the
 * reference by design, so a status on one has no declaration to contradict.
 * Whether a served route is missing from the document is the server's
 * `openapi-routes.test.ts` question, not this one.
 */
export function reportStatuses(
  lines: readonly RequestLine[],
  document: OpenApiLike,
): StatusReport {
  const declared = declaredStatuses(document);
  const observed = new Map<string, Map<number, Set<string>>>();
  const unpublished = new Map<string, Set<number>>();

  for (const line of lines) {
    // HEAD is answered by the GET handler unless the document gives it an
    // operation of its own, so it is held to what GET declares.
    const method =
      line.method === "HEAD" && !declared.has(`HEAD ${line.route}`)
        ? "GET"
        : line.method;
    // A catch-all mount serves published operations under one pattern —
    // Better Auth's `/auth/*` carries the registration door — so the
    // concrete path decides when the pattern names no operation.
    const byRoute = `${method} ${line.route}`;
    const byPath = `${method} ${line.path}`;
    const operation =
      !declared.has(byRoute) && line.route.includes("*") && declared.has(byPath)
        ? byPath
        : byRoute;
    if (!declared.has(operation)) {
      const statuses = unpublished.get(operation) ?? new Set<number>();
      statuses.add(line.status);
      unpublished.set(operation, statuses);
      continue;
    }
    const byStatus = observed.get(operation) ?? new Map<number, Set<string>>();
    const codes = byStatus.get(line.status) ?? new Set<string>();
    if (line.code !== undefined) codes.add(line.code);
    byStatus.set(line.status, codes);
    observed.set(operation, byStatus);
  }

  const undeclared: UndeclaredStatus[] = [];
  for (const [operation, byStatus] of observed) {
    const allowed = declared.get(operation) ?? new Set<number>();
    for (const [status, codes] of byStatus) {
      if (allowed.has(status)) continue;
      undeclared.push({
        operation,
        status,
        codes: [...codes].sort(),
        declared: [...allowed].sort((a, b) => a - b),
      });
    }
  }
  undeclared.sort(
    (a, b) => a.operation.localeCompare(b.operation) || a.status - b.status,
  );

  const unanswered: string[] = [];
  for (const [operation, statuses] of declared) {
    const drawn = observed.get(operation);
    for (const status of statuses) {
      if (HARNESS_UNREACHABLE_STATUSES.has(status)) continue;
      if (drawn?.has(status)) continue;
      unanswered.push(`${operation} ${String(status)}`);
    }
  }
  unanswered.sort();

  const unexplained = [...unpublished.keys()]
    .filter((route) => UNPUBLISHED_ROUTES[route] === undefined)
    .sort();

  return {
    observed,
    unpublished,
    unexplained,
    undeclared,
    unanswered,
    lines: lines.length,
  };
}

/**
 * Hold a run that reaches every door to {@link UNREACHED}: a declaration no
 * request drew and nothing listed, and a listed one a request did draw.
 */
export function unreachedDebt(
  report: StatusReport,
  listed: Readonly<Record<string, string>> = UNREACHED,
): { unlisted: string[]; stale: string[] } {
  const unanswered = new Set(report.unanswered);
  return {
    unlisted: report.unanswered.filter((key) => listed[key] === undefined),
    stale: Object.keys(listed)
      .filter((key) => !unanswered.has(key))
      .sort(),
  };
}

/** The observed table, one line per operation, for the run's output. */
export function formatObserved(report: StatusReport): string {
  return [...report.observed]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([operation, byStatus]) => {
      const statuses = [...byStatus]
        .sort(([a], [b]) => a - b)
        .map(([status, codes]) =>
          codes.size === 0
            ? String(status)
            : `${String(status)} (${[...codes].sort().join(", ")})`,
        )
        .join("  ");
      return `${operation}  ->  ${statuses}`;
    })
    .join("\n");
}

/** What a failing run prints: every status with no declaration behind it. */
export function formatUndeclared(report: StatusReport): string {
  return report.undeclared
    .map(
      (finding) =>
        `${finding.operation} answered ${String(finding.status)}` +
        (finding.codes.length > 0 ? ` (${finding.codes.join(", ")})` : "") +
        `; its document declares ${finding.declared.join(" ")}`,
    )
    .join("\n");
}
