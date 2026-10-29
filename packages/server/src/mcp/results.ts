/**
 * The shape of every tool answer: the payload as `structuredContent` and
 * the same JSON as the one text block, which is what a client that reads
 * only `content` gets. A refusal is the API's error, with what the agent
 * can do next.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ApiRefusal } from "./api.js";

export function ok<T extends Record<string, unknown>>(
  payload: T,
): CallToolResult & { structuredContent: T } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export interface ToolErrorBody {
  code: string;
  message: string;
  /** What the agent can do about it, where the error alone does not say. */
  hint?: string;
  [key: string]: unknown;
}

export function fail(error: ToolErrorBody): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    isError: true,
  };
}

/** What the API's error codes ask of an agent, where the message does not. */
const HINTS: Record<string, string> = {
  version_conflict:
    "Read the item again with marfa_get, decide whether your change still applies, and send the version you read.",
  item_not_found:
    "The item does not exist or this credential cannot read it. Find it again with marfa_find.",
  type_not_permitted: "This credential's grant does not reach this type.",
  unknown_type:
    "Call marfa_overview to see the types this instance has, and marfa_overview with type to see a type's fields.",
  validation_error:
    "Check the arguments against the tool's input schema and the type's fields from marfa_overview.",
  rate_limited: "Wait before calling again.",
  type_already_exists:
    "A type has this identifier. Change it with action change, or pick another identifier.",
  type_not_found:
    "No type has this identifier. Call marfa_overview to see the types.",
  type_move_blocked:
    "Change each setting in details.settings so it no longer names the type, then move again.",
  api_key_not_found:
    "No key this credential can reach has this ID. Call marfa_keys to see the keys.",
  webhook_not_found:
    "No webhook of this credential's has this ID. Call marfa_webhooks to see them.",
};

/** A refusal from the API, as a tool error. */
export function refused(
  refusal: ApiRefusal,
  extra: Record<string, unknown> = {},
): CallToolResult {
  const hint = HINTS[refusal.code];
  return fail({
    code: refusal.code,
    message: refusal.message,
    ...(refusal.details === undefined ? {} : { details: refusal.details }),
    ...(hint === undefined ? {} : { hint }),
    ...extra,
  });
}

/**
 * How long one tool answer may be, as JSON text. A client caps what one tool
 * answer may hold (Claude Code warns past about 10,000 tokens and cuts at
 * 25,000 by default), and an answer past the cap is lost to the agent, so
 * every tool keeps its answer under `ANSWER_BUDGET_CHARS`.
 */
export const ANSWER_BUDGET_CHARS = 40_000;

/**
 * Text from `offset`, in code points, as much as takes at most `room`
 * characters once written as a JSON string, with what was left.
 */
export function cutText(
  text: string,
  offset: number,
  room: number,
): { text: string; next_offset: number | null; total_chars: number } {
  const points = Array.from(text);
  const start = Math.min(Math.max(0, offset), points.length);
  let end = start;
  let used = 0;
  while (end < points.length) {
    const width = JSON.stringify(points[end]).length - 2;
    if (used + width > room) break;
    used += width;
    end += 1;
  }
  return {
    text: points.slice(start, end).join(""),
    next_offset: end < points.length ? end : null,
    total_chars: points.length,
  };
}

/**
 * As many of `entries` as fit in `room` characters of JSON, in order, and
 * how many were left out.
 */
export function fitList<T>(
  entries: readonly T[],
  room: number,
): { kept: T[]; left_out: number } {
  const kept: T[] = [];
  let used = 2;
  for (const entry of entries) {
    const width = JSON.stringify(entry).length + 1;
    if (used + width > room) break;
    used += width;
    kept.push(entry);
  }
  return { kept, left_out: entries.length - kept.length };
}
