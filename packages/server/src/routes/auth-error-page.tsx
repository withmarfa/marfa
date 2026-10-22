/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/** The page `GET /auth/error` answers. */
import { Button } from "../pages/parts/controls.js";
import { MomentCard } from "../pages/parts/layout.js";
import { PageShell } from "../pages/parts/shell.js";
import { renderDocument } from "../pages/render.js";

/**
 * Friendly copy per OAuth error code. The raw protocol token is never shown to
 * the user; an unknown code falls back to the generic line below.
 */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_client:
    "We didn't recognize the app that sent you here, so nothing was shared.",
  invalid_request: "That sign-in link was incomplete.",
  invalid_scope: "That app asked for something this server doesn't offer.",
  unsupported_response_type:
    "That app started sign-in in a way this server doesn't support.",
  access_denied: "You canceled sign-in. Nothing was shared.",
  server_error: "Something failed on our side while signing you in.",
  temporarily_unavailable:
    "Sign-in is briefly unavailable. It usually returns within a minute.",
};

const GENERIC_MESSAGE = "We couldn't finish signing you in.";

/**
 * Render the OAuth error page as a complete HTML document. Pure (the route
 * handler is the only caller) so the copy is unit-testable without booting the
 * app. The raw error code is only ever used as a lookup key into the curated
 * message map — it is never reflected into the output.
 */
export function renderAuthErrorPage(
  errorCode: string | null,
  nonce: string,
): string {
  const message = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? GENERIC_MESSAGE)
    : GENERIC_MESSAGE;
  return renderDocument(
    <PageShell title="Sign-in error" nonce={nonce} needsScript={false}>
      <MomentCard title="Couldn't sign you in" lede={message}>
        <Button kind="primary" wide href="/auth/sign-in">
          Back to sign in
        </Button>
      </MomentCard>
    </PageShell>,
  );
}
