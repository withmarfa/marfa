/**
 * Email transport factory. Constructs the right backend per
 * `MYME_EMAIL_BACKEND` config, applies the sender-domain check for
 * the Cloudflare backend, and returns the transport ready to use.
 *
 * Called once at boot in `index.ts` and threaded into auth + any
 * future email-sending route. Never returns null — when the backend
 * is unconfigured (`none`) the transport explicitly fails with
 * `email_transport_not_configured` on every send, which is the
 * desired loud-failure shape (no silent dead-lettering).
 */
import type { EmailTransport, EmailTransportConfig } from "./transport.js";
import { NoneTransport } from "./none-backend.js";
import {
  checkSenderDomain,
  SenderDomainMismatchError,
} from "./sender-domain-check.js";
import { log } from "../middleware/logger.js";

export type {
  EmailTransport,
  EmailMessage,
  EmailSendResult,
} from "./transport.js";
export { NoneTransport } from "./none-backend.js";
export { CloudflareTransport } from "./cloudflare-backend.js";
export { SmtpTransport } from "./smtp-backend.js";
export { SenderDomainMismatchError } from "./sender-domain-check.js";

export async function createEmailTransport(
  config: EmailTransportConfig,
): Promise<EmailTransport> {
  // Sender-domain check fires first. Failing loud at boot is the whole
  // point — surfacing it inside `send()` would let bad config into
  // production. The check is a no-op for `none` / `smtp` backends.
  checkSenderDomain({ backend: config.backend, from: config.from });

  switch (config.backend) {
    case "none": {
      log("info", "Email transport: none (email-dependent flows will 503)");
      return new NoneTransport();
    }
    case "cloudflare": {
      if (!config.cloudflare?.accountId || !config.cloudflare.apiToken) {
        throw new Error(
          "MYME_EMAIL_BACKEND=cloudflare requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN to be set",
        );
      }
      const { createCloudflareTransport } =
        await import("./cloudflare-backend.js");
      const transport = createCloudflareTransport(config);
      log("info", "Email transport: cloudflare", { from: config.from });
      return transport;
    }
    case "smtp": {
      if (!config.smtp?.host) {
        throw new Error(
          "MYME_EMAIL_BACKEND=smtp requires MYME_SMTP_HOST to be set",
        );
      }
      const { createSmtpTransport } = await import("./smtp-backend.js");
      const transport = await createSmtpTransport(config);
      log("info", "Email transport: smtp", {
        from: config.from,
        host: config.smtp.host,
      });
      return transport;
    }
    default: {
      // Compile-time exhaustiveness check.
      const _exhaustive: never = config.backend;
      void _exhaustive;
      throw new Error(`Unknown email backend: ${String(config.backend)}`);
    }
  }
}

export { SenderDomainMismatchError as _SenderDomainMismatchError };
