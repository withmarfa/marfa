/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The page where a person types the code a device showed them (RFC 8628).
 * The approval screen and the page that ends it are in `device-approval.tsx`.
 *
 * It takes an optional `user_code` to fill the field, so the
 * `verification_uri_complete` link a device prints can land the person at
 * consent. One form posts to `POST /auth/device`, which answers every outcome
 * with a redirect, so a browser with no script uses it by a plain form post;
 * the script only writes the code as it is typed.
 */
import { DEVICE_CODE_LIFETIME_MINUTES } from "../auth/device-code-lifetime.js";
import { waitInMinutes } from "../pages/lockout.js";
import {
  Button,
  MomentCard,
  PageShell,
  TextField,
} from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";

interface DevicePageParams {
  /** Pre-filled user_code from ?user_code=X. Optional. */
  prefilled: string;
  /** Error code from a previous attempt. */
  error?: string;
  /** The whole seconds until another attempt will be allowed, from the
   *  `retry_after` the server redirected with. */
  retryAfter?: number;
  /** The nonce the response's content security policy names. */
  nonce: string;
}

/** What a code the server did not accept says: it may be wrong or past its end. */
const NOT_RIGHT =
  "That code isn't right or has ended. Check your device for a new one.";

const ERROR_MESSAGES: Record<string, string> = {
  missing_code: "Enter the code shown on your device.",
  invalid_code: NOT_RIGHT,
  expired_code: NOT_RIGHT,
  already_resolved:
    "That code has already been used. Check your device for a new one.",
  another_account:
    "That code was started under a different account. Sign in as that account, or start again on your device.",
};

/** What a code lookup refused by a limit says: the wait, when the server gave one. */
function tooManyCodesMessage(retryAfter: number | undefined): string {
  return retryAfter === undefined
    ? "Too many codes have been tried. Try again later."
    : `Too many codes have been tried. Try again in ${waitInMinutes(retryAfter)}.`;
}

/** Renders the form where a person types the code a device showed them. */
export function renderDevicePage(params: DevicePageParams): string {
  const message =
    params.error === undefined
      ? undefined
      : params.error === "too_many_attempts"
        ? tooManyCodesMessage(params.retryAfter)
        : (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.");
  return renderDocument(
    <PageShell
      title="Connect a device"
      nonce={params.nonce}
      needsScript={false}
      enhancedByScript
    >
      <MomentCard
        title="Connect a device"
        lede="Enter the code shown on your device."
      >
        <form
          class="stack"
          method="post"
          action="/auth/device"
          novalidate
          data-device-form
        >
          <TextField
            id="device-code"
            name="user_code"
            label="Code"
            full
            code
            required
            requiredMessage="Enter the code shown on your device."
            placeholder="XXXX-XXXX"
            value={params.prefilled}
            autocomplete="off"
            autofocus
            hint={`Codes end after ${waitInMinutes(DEVICE_CODE_LIFETIME_MINUTES * 60)}.`}
            error={message}
            data={{ "device-code": "" }}
          />
          <Button kind="primary" type="submit" wide loadingLabel="Checking...">
            Continue
          </Button>
        </form>
      </MomentCard>
    </PageShell>,
  );
}
