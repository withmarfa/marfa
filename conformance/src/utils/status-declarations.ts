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
  undeclared: UndeclaredStatus[];
  /** Request lines read, so an empty log cannot read as a clean run. */
  lines: number;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

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
    // A catch-all mount serves published operations under one pattern —
    // Better Auth's `/auth/*` carries the registration door — so the
    // concrete path decides when the pattern names no operation.
    const byRoute = `${line.method} ${line.route}`;
    const byPath = `${line.method} ${line.path}`;
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

  return { observed, unpublished, undeclared, lines: lines.length };
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
