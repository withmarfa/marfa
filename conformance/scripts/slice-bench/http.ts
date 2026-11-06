/**
 * Talking to the server under test, knowing only its state directory. The
 * URL and key come from `<state>/env`, which the conformance adapter writes on
 * every boot, so a restart that moves the port is followed by reading it again.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnvFile } from "../../src/utils/target.js";

export interface Target {
  url: string;
  key: string;
}

export function connect(state: string): Target {
  const file = resolve(state, "env");
  const env = parseEnvFile(readFileSync(file, "utf8"));
  const url = env.MARFA_API_URL;
  const key = env.MARFA_API_KEY;
  if (!url || !key) throw new Error(`${file} names no server and key`);
  return { url: url.replace(/\/$/, ""), key };
}

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface Reply {
  /** 0 when the server did not answer. */
  status: number;
  /** From sending the request to the whole body read. */
  ms: number;
  text: string;
}

export const ok = (reply: Reply) => reply.status >= 200 && reply.status < 300;

/**
 * What a server answers for a door it does not have. A real door never
 * answers these for the requests the benchmark sends (a list, a search, a
 * bulk page, or an item the server itself just created).
 */
export const missingDoor = (reply: Reply) =>
  reply.status === 404 || reply.status === 405 || reply.status === 501;

export function parse<T>(reply: Reply): T | undefined {
  try {
    return JSON.parse(reply.text) as T;
  } catch {
    return undefined;
  }
}

/** One request, never retried: rate limiting is off on a benchmark boot. */
export async function request(
  target: Target,
  method: Method,
  path: string,
  body?: string | object,
  options: { auth?: boolean; timeoutMs?: number } = {},
): Promise<Reply> {
  const payload =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (options.auth !== false) headers.Authorization = `Bearer ${target.key}`;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const start = performance.now();
  try {
    const response = await fetch(`${target.url}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
    });
    const text = await response.text();
    return { status: response.status, ms: performance.now() - start, text };
  } catch (error) {
    return { status: 0, ms: performance.now() - start, text: String(error) };
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));
