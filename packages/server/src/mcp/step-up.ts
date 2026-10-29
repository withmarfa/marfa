/**
 * Which scope a tool call by a signed-in app was refused for, so the
 * endpoint can answer with a challenge the app steps its sign-in up from
 * (MCP authorization, RFC 6750 §3.1) in place of a tool error the person
 * cannot act on.
 */
import { isValidScope } from "@withmarfa/shared";

interface ToolCall {
  id: string | number;
}

/** Whether `message` is one `tools/call` request. */
export function isToolCall(message: unknown): message is ToolCall {
  if (typeof message !== "object" || message === null) return false;
  const { method, id } = message as { method?: unknown; id?: unknown };
  return (
    method === "tools/call" &&
    (typeof id === "string" || typeof id === "number")
  );
}

/** The scope literal a refusal's details name as missing. */
export function scopeOfRefusal(
  details: Record<string, unknown> | undefined,
): string | undefined {
  if (details === undefined) return undefined;
  const grant = details.grant as
    { kind?: unknown; name?: unknown; level?: unknown } | undefined;
  let scope: string | undefined;
  if (typeof grant?.name === "string" && typeof grant.level === "string") {
    if (grant.kind === "type") scope = `${grant.name}:${grant.level}`;
    if (grant.kind === "edge_type") scope = `edge.${grant.name}:${grant.level}`;
  } else if (typeof details.required_scope === "string") {
    scope = details.required_scope;
  }
  return scope !== undefined && isValidScope(scope) ? scope : undefined;
}

/** The JSON-RPC messages of a response body, whether JSON or a stream. */
function messagesOf(body: string, contentType: string | null): unknown[] {
  const parse = (text: string): unknown[] => {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  };
  if (contentType?.startsWith("text/event-stream") !== true) return parse(body);
  return body.split(/\r?\n\r?\n/).flatMap((event) =>
    parse(
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n"),
    ),
  );
}

/**
 * The scope the answer to `call` was refused for: its result is a tool
 * error whose details name a scope.
 */
export function scopeTheCallLacked(
  call: ToolCall,
  body: string,
  contentType: string | null,
): string | undefined {
  for (const message of messagesOf(body, contentType)) {
    const { id, result } = message as {
      id?: unknown;
      result?: { isError?: unknown; content?: unknown };
    };
    if (id !== call.id || result?.isError !== true) continue;
    const content: unknown[] = Array.isArray(result.content)
      ? result.content
      : [];
    const text = (content[0] as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") return undefined;
    try {
      const { error } = JSON.parse(text) as {
        error?: { details?: Record<string, unknown> };
      };
      return scopeOfRefusal(error?.details);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
