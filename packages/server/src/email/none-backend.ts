/**
 * `none` backend — explicit no-transport. Returns a structured error
 * on every send. Default if `MYME_EMAIL_BACKEND` is unset.
 *
 * The point of this backend (vs simply having `transport === undefined`)
 * is that email-dependent flows fail with a clear, attributable error
 * instead of a silent dead-letter. `email_transport_not_configured`
 * surfaces 503 to the API caller and prompts operators to wire a
 * backend.
 */
import type {
  EmailMessage,
  EmailSendResult,
  EmailTransport,
} from "./transport.js";

export class NoneTransport implements EmailTransport {
  readonly backend = "none" as const;

  send(message: EmailMessage): Promise<EmailSendResult> {
    void message;
    return Promise.resolve({
      ok: false,
      error: "email_transport_not_configured",
      retryable: false,
    });
  }
}
