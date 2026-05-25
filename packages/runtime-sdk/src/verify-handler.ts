/**
 * Synchronous verify-handler entry point for per-Integration Workers
 * (T-082). Wraps `dispatchMessage` with HTTP request/response shaping
 * so the runtime-control verify route can dispatch a one-shot envelope
 * over a service binding and read the `HandlerResult` synchronously.
 *
 * Integration workers grow a `POST /verify` entry point that calls
 * `verifyHandler(env, request)`. The control plane is responsible for
 * synthesising a valid envelope (using the same `buildQueueMessageBody`
 * helper the reactive-run bridge uses); this function trusts the
 * envelope, builds the `ConnectionContext`, and runs `dispatchMessage`
 * once.
 *
 * Persistence is real — verify executes against the connection's actual
 * runtime credential and writes through the same Marfa API the
 * production queue path does. There is no dry-run mode (preview-event
 * already covers static envelope rendering).
 */
import { dispatchMessage } from "./handlers.js";
import {
  buildConnectionContext,
  type ConsumerEnvironment,
} from "./queue-consumer.js";
import type { HandlerResult, QueueMessage } from "./types.js";

/**
 * Wire shape the runtime-control verify route POSTs to the integration
 * Worker's `/verify` endpoint. The Worker round-trips the envelope back
 * in `envelope_used` so the operator can confirm the shape that ran.
 */
export interface VerifyRequestBody {
  envelope: QueueMessage;
}

export interface VerifyResponseBody {
  ok: boolean;
  handler_result: HandlerResult;
  envelope_used: QueueMessage;
}

/**
 * Run a single envelope through the integration's registered handler
 * and return the result as JSON. Mirrors the per-message decision the
 * queue consumer makes, minus the queue-runtime ack/retry side effects
 * — verify is a one-shot debug call, not a queued delivery.
 *
 * The Worker's `fetch` handler invokes this for `POST /verify` and
 * returns the resulting Response unmodified.
 */
export async function verifyHandler(
  env: ConsumerEnvironment,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405 },
    );
  }

  // Treat the parsed body as Partial — the wire is operator-supplied
  // JSON; missing-field surfaces should be 400 not type errors at the
  // gate. Cast back to the contract once envelope is checked.
  let body: { envelope?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const rawEnvelope = body.envelope;
  if (!rawEnvelope || typeof rawEnvelope !== "object") {
    return Response.json(
      { ok: false, error: "missing_envelope" },
      { status: 400 },
    );
  }
  const envelope = rawEnvelope as QueueMessage;

  // Envelope-filter mirror — the integration Worker's queue consumer
  // checks `integration_name` matches `env.integrationName` and skips
  // mismatches. The verify path applies the same gate so a misrouted
  // verify call (operator hits the wrong integration's binding) gets a
  // clean 400 rather than running a foreign envelope.
  if (envelope.integration_name !== env.integrationName) {
    return Response.json(
      {
        ok: false,
        error: "integration_mismatch",
        expected: env.integrationName,
        received: envelope.integration_name,
      },
      { status: 400 },
    );
  }

  let result: HandlerResult;
  try {
    const ctx = await buildConnectionContext(env, envelope);
    result = await dispatchMessage(ctx, envelope);
  } catch (err) {
    result = {
      ok: false,
      retry: false,
      reason: `dispatch_threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const response: VerifyResponseBody = {
    ok: result.ok,
    handler_result: result,
    envelope_used: envelope,
  };
  return Response.json(response, { status: 200 });
}
