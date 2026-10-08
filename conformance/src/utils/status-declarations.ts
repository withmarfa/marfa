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

import { readFileSync } from "node:fs";

/** One request as `middleware/logger.ts` writes it. */
export interface RequestLine {
  method: string;
  /** Assigned by the server listener, never by request headers. */
  transport: "http" | "local_socket";
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
  /** Private socket operations, outside the public HTTP contract. */
  local: Map<string, Set<number>>;
  undeclared: UndeclaredStatus[];
  /**
   * `METHOD /path status code` for a refusal code drawn on a declared
   * status that declares other codes and not this one: a caller switching
   * on the declared set meets a code it was never told of.
   */
  undeclaredCodes: string[];
  /**
   * Declared statuses no request drew, by operation, less the ones the
   * harness cannot reach by construction. Only meaningful over a run that
   * reaches every door; see {@link unreachedDebt}.
   */
  unanswered: string[];
  /** Exempt codes the document no longer declares anywhere. */
  staleCodes: string[];
  /** Undeclared statuses this run drew that `findings.md` records. */
  recorded: string[];
  /** Request lines read, so an empty log cannot read as a clean run. */
  lines: number;
}

const HTTP_METHODS = ["get", "head", "post", "put", "patch", "delete"];

/**
 * The routes the server serves outside its document, each with why: the
 * server's own list, which its route walk holds to its route table, and the
 * sign-in library's catch-all, which that walk does not see because it is a
 * pattern rather than a door. A served route missing from here is reported,
 * so the document cannot lose a door into this bucket without somebody
 * writing the reason down.
 */
export const UNPUBLISHED_ROUTES: Readonly<Record<string, string>> = {
  ...(JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/server/unpublished-routes.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, string>),
  "GET /auth/*":
    "the sign-in library's own endpoints, a browser's and an OAuth client's rather than an API caller's",
  "POST /auth/*":
    "the same; the one door under it the document publishes, client registration, is resolved by its path",
};

/**
 * Refusals the harness's server cannot be made to answer on most doors, by
 * code. A declared status is exempt from being drawn only when every code
 * the document declares on it is here or in {@link RACE_CODES}, so a door's
 * own refusal on the same status is still held to a fixture.
 */
export const HARNESS_CODES: Readonly<Record<string, string>> = {
  rate_limited:
    "the limiter, which `marfa:up` boots with rate limiting off so a full suite does not throttle itself",
  request_too_large:
    "the body cap, drawn on the doors whose own chapter says what it means there",
  write_contention:
    "the database's write lock, drawn by holding it from outside the server on the doors `errors/contention` names",
  insufficient_storage:
    "a volume the harness cannot fill, drawn on `POST /blobs` and `POST /restore` by a server booted with a reserve no volume can keep",
  internal_error:
    "a fault the server holds no refusal for, which no request provokes; drawn once, on `GET /audit`, by renaming a table in the fixture server's own file",
};

/**
 * Refusals a run draws only when two requests race, so one run draws them
 * and the next does not, by code.
 */
export const RACE_CODES: Readonly<Record<string, string>> = {
  idempotency_key_in_flight:
    "a second request under a key whose first is still being written, which two concurrent requests draw when they interleave",
  housekeeping_job_running:
    "a run already holding the job, which a request draws when the scheduler has started one, as an upload does",
};

/**
 * Declared statuses on a door's own account that no fixture draws, each
 * with what drawing one would take. The list is the size of what the
 * document says and nothing asserts: a run that draws one of these reports
 * the entry as stale, and a run that leaves a declaration undrawn and
 * unlisted fails.
 */
export const UNREACHED: Readonly<Record<string, string>> = {};

/**
 * Undeclared statuses the server answers that `findings.md` records, keyed
 * `METHOD /path status`, each naming its entry. The fixture that shows one
 * asserts what the server does, so the run draws it; recorded here it is
 * reported as recorded rather than as a new contradiction, and an entry no
 * run draws any more is stale, since the server stopped answering it.
 */
export const RECORDED: Readonly<Record<string, string>> = {};

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
      transport: line.transport === "local_socket" ? "local_socket" : "http",
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
  components?: Record<string, unknown>;
}

/** Follow `$ref`s through the document. The document has no cycle. */
function resolveRefs(node: unknown, document: OpenApiLike): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, document));
  if (node === null || typeof node !== "object") return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === "string") {
    const target = ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>(
        (at, segment) =>
          at === null || typeof at !== "object"
            ? undefined
            : (at as Record<string, unknown>)[segment],
        document,
      );
    return resolveRefs(target, document);
  }
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [k, resolveRefs(v, document)]),
  );
}

/** The refusal codes a response schema declares, under `error.code` or as
 *  an RFC shape's top-level `error`. */
function codesIn(schema: unknown): string[] {
  const record = (schema ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = record[key];
    if (Array.isArray(branches)) out.push(...branches.flatMap(codesIn));
  }
  type ErrorPart = { properties?: { code?: unknown }; enum?: unknown };
  const error = (record.properties as Record<string, unknown> | undefined)
    ?.error as (ErrorPart & { allOf?: unknown }) | undefined;
  // A described `error` is published as an `allOf` of its schema and its text.
  const parts = [error, ...(Array.isArray(error?.allOf) ? error.allOf : [])];
  for (const part of parts as (ErrorPart | undefined)[]) {
    const code = (part?.properties?.code ?? part) as
      { enum?: unknown } | undefined;
    if (Array.isArray(code?.enum)) {
      out.push(...code.enum.filter((c): c is string => typeof c === "string"));
    }
  }
  return out;
}

/** `METHOD /path` to each declared status's refusal codes. */
export function declaredCodes(
  document: OpenApiLike,
): Map<string, Map<number, Set<string>>> {
  const out = new Map<string, Map<number, Set<string>>>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const responses = (operation as { responses?: Record<string, unknown> })
        .responses;
      const byStatus = new Map<number, Set<string>>();
      for (const [key, response] of Object.entries(responses ?? {})) {
        const status = Number.parseInt(key, 10);
        if (!Number.isInteger(status)) continue;
        const content = (
          response as { content?: Record<string, { schema?: unknown }> }
        ).content;
        const codes = new Set<string>();
        for (const media of Object.values(content ?? {})) {
          for (const code of codesIn(resolveRefs(media.schema, document))) {
            codes.add(code);
          }
        }
        byStatus.set(status, codes);
      }
      out.set(`${method.toUpperCase()} ${path}`, byStatus);
    }
  }
  return out;
}

/** Whether a declared status is exempt from being drawn: every code it
 *  declares is the harness's or a race's. */
function exempt(codes: ReadonlySet<string> | undefined): boolean {
  if (codes === undefined || codes.size === 0) return false;
  return [...codes].every(
    (code) =>
      HARNESS_CODES[code] !== undefined || RACE_CODES[code] !== undefined,
  );
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
  recordedStatuses: Readonly<Record<string, string>> = RECORDED,
): StatusReport {
  const declared = declaredStatuses(document);
  const observed = new Map<string, Map<number, Set<string>>>();
  const unpublished = new Map<string, Set<number>>();
  const local = new Map<string, Set<number>>();

  for (const line of lines) {
    if (line.transport === "local_socket") {
      const operation = `${line.method} ${line.route}`;
      const statuses = local.get(operation) ?? new Set<number>();
      statuses.add(line.status);
      local.set(operation, statuses);
      continue;
    }
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
  const recorded: string[] = [];
  for (const [operation, byStatus] of observed) {
    const allowed = declared.get(operation) ?? new Set<number>();
    for (const [status, codes] of byStatus) {
      if (allowed.has(status)) continue;
      const key = `${operation} ${String(status)}`;
      if (recordedStatuses[key] !== undefined) {
        recorded.push(key);
        continue;
      }
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

  const codes = declaredCodes(document);
  const undeclaredCodes: string[] = [];
  for (const [operation, byStatus] of observed) {
    for (const [status, seen] of byStatus) {
      const declaredHere = codes.get(operation)?.get(status);
      // A status with no code of its own, a success or a shape outside the
      // envelope, has no set for a code to be missing from.
      if (declaredHere === undefined || declaredHere.size === 0) continue;
      for (const code of seen) {
        if (!declaredHere.has(code)) {
          undeclaredCodes.push(`${operation} ${String(status)} ${code}`);
        }
      }
    }
  }
  undeclaredCodes.sort();

  const unanswered: string[] = [];
  for (const [operation, statuses] of declared) {
    const drawn = observed.get(operation);
    for (const status of statuses) {
      if (exempt(codes.get(operation)?.get(status))) continue;
      if (drawn?.has(status)) continue;
      unanswered.push(`${operation} ${String(status)}`);
    }
  }
  unanswered.sort();

  const unexplained = [...unpublished.keys()]
    .filter((route) => UNPUBLISHED_ROUTES[route] === undefined)
    .sort();

  const everyCode = new Set(
    [...codes.values()].flatMap((byStatus) =>
      [...byStatus.values()].flatMap((set) => [...set]),
    ),
  );
  const staleCodes = [...Object.keys(HARNESS_CODES), ...Object.keys(RACE_CODES)]
    .filter((code) => !everyCode.has(code))
    .sort();

  return {
    observed,
    unpublished,
    local,
    unexplained,
    undeclared,
    undeclaredCodes,
    unanswered,
    staleCodes,
    recorded: recorded.sort(),
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
  recordedStatuses: Readonly<Record<string, string>> = RECORDED,
): { unlisted: string[]; stale: string[] } {
  const unanswered = new Set(report.unanswered);
  return {
    unlisted: report.unanswered.filter((key) => listed[key] === undefined),
    stale: [
      ...Object.keys(listed)
        .filter((key) => !unanswered.has(key))
        .sort(),
      ...report.staleCodes.map((code) => `code ${code}`),
      ...Object.keys(recordedStatuses)
        .filter((key) => !report.recorded.includes(key))
        .map((key) => `recorded ${key}`),
    ],
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
