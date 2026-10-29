/**
 * Fetch a file from a URL someone else chose, reaching only public
 * addresses: what an MCP tool uses to save a file an agent names by its web
 * address.
 *
 * The rules are the webhook delivery's (`public-address.ts`): the address
 * checked is the address connected to, and a redirect is not followed,
 * since following one would connect to an address nobody checked. A body is
 * read only up to the size cap, so a file larger than the instance takes is
 * refused without being held in memory.
 */
import { Agent, fetch } from "undici";
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
} as const;

export type PublicFetchOutcome =
  | {
      kind: "fetched";
      bytes: Uint8Array;
      /** The type the answer named, without its parameters, or null. */
      mimeType: string | null;
      /** The name a `Content-Disposition` answer gave, or null. */
      fileName: string | null;
    }
  | {
      kind: "failed";
      reason: keyof typeof FETCH_FAILURE;
      message: string;
      /** The HTTP status, where the address answered. */
      status?: number;
    };

export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs: number;
}

export type PublicFetcher = (url: string) => Promise<PublicFetchOutcome>;

function failed(
  reason: keyof typeof FETCH_FAILURE,
  status?: number,
): PublicFetchOutcome {
  return {
    kind: "failed",
    reason,
    message: FETCH_FAILURE[reason],
    ...(status === undefined ? {} : { status }),
  };
}

class TooLargeError extends Error {}

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
  return async (raw) => {
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
    const signal = AbortSignal.timeout(options.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        dispatcher,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        return failed("redirect", response.status);
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return failed("status", response.status);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return failed("too_large");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body !== null) {
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > options.maxBytes) throw new TooLargeError();
          chunks.push(chunk);
        }
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      const type = response.headers.get("content-type");
      const named = type?.split(";")[0]?.trim().toLowerCase() ?? "";
      const mimeType = named === "" ? null : named;
      return {
        kind: "fetched",
        bytes,
        mimeType,
        fileName: dispositionName(response.headers.get("content-disposition")),
      };
    } catch (err) {
      if (err instanceof TooLargeError) return failed("too_large");
      if (hasCause(err, (e) => e instanceof AddressNotPublicError)) {
        return failed("not_public");
      }
      if (
        hasCause(
          err,
          (e) =>
            e instanceof Error &&
            (e.name === "AbortError" || e.name === "TimeoutError"),
        )
      ) {
        return failed("timeout");
      }
      return failed("unreachable");
    }
  };
}
