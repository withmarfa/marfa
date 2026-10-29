/**
 * Fetch a file from a URL someone else chose, reaching only public
 * addresses: what an MCP tool uses to save a file an agent names by its web
 * address.
 *
 * The rules are the webhook delivery's (`public-address.ts`): the address
 * checked is the address connected to, and a redirect is not followed,
 * since following one would connect to an address nobody checked. The body
 * is handed on as it arrives and counted on the way, so no file is held in
 * memory and one larger than the cap is stopped at the cap.
 */
import { Agent, fetch } from "undici";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import {
  AddressNotPublicError,
  connectionLookup,
  hasCause,
  isPublicAddress,
  literalAddress,
} from "./public-address.js";

/** Why a fetch brought back no file, in words an agent can act on. */
export const FETCH_FAILURE = {
  bad_url:
    "The file's address must be an http or https URL without credentials.",
  not_public:
    "The file's address is not public, so the server does not fetch it.",
  redirect:
    "The file's address answered with a redirect, which is not followed. Give the address it redirects to.",
  timeout: "The file's address did not answer in time.",
  unreachable: "The file's address could not be reached.",
  too_large: "The file is larger than this instance accepts.",
  status: "The file's address did not answer with the file.",
  busy: "The server is fetching as many files as it fetches at once. Try again in a moment.",
} as const;

export type FetchFailureReason = keyof typeof FETCH_FAILURE;

export interface PublicFetchFailure {
  kind: "failed";
  reason: FetchFailureReason;
  message: string;
  /** The HTTP status, where the address answered. */
  status?: number;
}

/** A file on its way, for the caller to save. */
export interface FetchedFile {
  /** The bytes as they arrive; it errors once they pass the cap. */
  body: ReadableStream<Uint8Array>;
  /** The type the answer named, without its parameters, or null. */
  mimeType: string | null;
  /** The name a `Content-Disposition` answer gave, or null. */
  fileName: string | null;
}

export type PublicFetchOutcome<T> =
  | {
      kind: "fetched";
      /** What the caller's `save` answered. */
      value: T;
      /** How many bytes arrived. */
      size: number;
    }
  | PublicFetchFailure;

export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  /** How many fetches the fetcher makes at once; one more is refused. */
  maxConcurrent: number;
}

/**
 * Fetches `url` and hands the file to `save` as it arrives. When the body
 * stops short (past the cap, out of time, cut off), the outcome is that
 * failure, whatever `save` answered.
 */
export type PublicFetcher = <T>(
  url: string,
  save: (file: FetchedFile) => Promise<T>,
) => Promise<PublicFetchOutcome<T>>;

function failed(
  reason: FetchFailureReason,
  status?: number,
): PublicFetchFailure {
  return {
    kind: "failed",
    reason,
    message: FETCH_FAILURE[reason],
    ...(status === undefined ? {} : { status }),
  };
}

function isAbort(err: unknown): boolean {
  return hasCause(
    err,
    (e) =>
      e instanceof Error &&
      (e.name === "AbortError" || e.name === "TimeoutError"),
  );
}

/**
 * The error a body that stopped short ends with. It reaches the upload the
 * body was handed to, which answers it as a refusal rather than a fault.
 */
function stoppedShort(reason: FetchFailureReason): MarfaError {
  const code =
    reason === "too_large"
      ? ErrorCode.REQUEST_TOO_LARGE
      : reason === "timeout"
        ? ErrorCode.REQUEST_TIMEOUT
        : ErrorCode.VALIDATION_ERROR;
  return new MarfaError(code, FETCH_FAILURE[reason]);
}

/** The `filename` a `Content-Disposition` header names, if any. */
function dispositionName(header: string | null): string | null {
  if (header === null) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // A malformed extended name falls back to the plain one.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/.exec(header);
  const name = (plain?.[1] ?? plain?.[2])?.trim();
  return name === undefined || name === "" ? null : name;
}

/** A fetcher that holds to `options` for every URL it is given. */
export function createPublicFetcher(
  options: PublicFetchOptions,
): PublicFetcher {
  const dispatcher = new Agent({
    connect: {
      lookup: connectionLookup({
        allowPrivateAddresses: false,
        refusal: FETCH_FAILURE.not_public,
      }),
    },
  });
  let active = 0;
  return async <T>(
    raw: string,
    save: (file: FetchedFile) => Promise<T>,
  ): Promise<PublicFetchOutcome<T>> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return failed("bad_url");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return failed("bad_url");
    }
    const literal = literalAddress(url);
    if (literal !== null && !isPublicAddress(literal)) {
      return failed("not_public");
    }
    if (active >= options.maxConcurrent) return failed("busy");
    active += 1;
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const stop = new AbortController();
    const stopped: { reason: FetchFailureReason | null } = { reason: null };
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any([timeout, stop.signal]),
        dispatcher,
      });
      if (response.status >= 300 && response.status < 400) {
        return failed("redirect", response.status);
      }
      if (response.status !== 200) {
        return failed("status", response.status);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        return failed("too_large");
      }
      const reader = (
        response.body as ReadableStream<Uint8Array> | null
      )?.getReader();
      let size = 0;
      const stopWith = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        reason: FetchFailureReason,
      ): void => {
        stopped.reason = reason;
        controller.error(stoppedShort(reason));
        stop.abort();
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (reader === undefined) {
            controller.close();
            return;
          }
          let next: Awaited<ReturnType<typeof reader.read>>;
          try {
            next = await reader.read();
          } catch (err) {
            stopWith(
              controller,
              timeout.aborted && isAbort(err) ? "timeout" : "unreachable",
            );
            return;
          }
          if (next.done) {
            controller.close();
            return;
          }
          size += next.value.byteLength;
          if (size > options.maxBytes) {
            stopWith(controller, "too_large");
            return;
          }
          controller.enqueue(next.value);
        },
        cancel() {
          stop.abort();
        },
      });
      const type = response.headers.get("content-type");
      const named = type?.split(";")[0]?.trim().toLowerCase() ?? "";
      const value = await save({
        body,
        mimeType: named === "" ? null : named,
        fileName: dispositionName(response.headers.get("content-disposition")),
      });
      if (stopped.reason !== null) return failed(stopped.reason);
      return { kind: "fetched", value, size };
    } catch (err) {
      if (stopped.reason !== null) return failed(stopped.reason);
      if (hasCause(err, (e) => e instanceof AddressNotPublicError)) {
        return failed("not_public");
      }
      if (isAbort(err)) return failed("timeout");
      return failed("unreachable");
    } finally {
      // Ends the connection of a body the caller left unread.
      stop.abort();
      active -= 1;
    }
  };
}
