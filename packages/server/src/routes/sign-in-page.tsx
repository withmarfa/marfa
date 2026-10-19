/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The sign-in page for the human-facing /auth/sign-in surface.
 *
 * One form posts to `POST /auth/sign-in`, which dispatches to Better Auth's
 * JSON API and answers success and failure with 302s, so a browser with no
 * script signs in by a plain form post. The script only adds the passkey
 * button, the password toggle and the form's inline checks.
 */
import { DEFAULT_INSTANCE_NAME } from "../instance-name.js";
import { localHref } from "../pages/href.js";
import { renderDocument } from "../pages/render.js";
import { waitInMinutes } from "../pages/lockout.js";
import {
  Button,
  Divider,
  MomentCard,
  Notice,
  PageShell,
  PasswordField,
  TextField,
} from "../pages/parts/index.js";

export interface SignInPageParams {
  instanceName?: string;
  /** The address people reach the instance at, shown under the title. */
  address?: string;
  /** The nonce the response's content security policy names. */
  nonce: string;
  /**
   * Where to send the user after a successful sign-in, already passed
   * through `validateReturnTo`. Carried in the form's hidden field so it
   * survives the round-trip.
   */
  returnTo: string;
  /**
   * Error code from a previous attempt. Unknown codes fall through to a
   * generic message rather than 500-ing.
   */
  error?: string;
  /**
   * The whole seconds until another attempt will be allowed, from the
   * `retry_after` the server redirected with.
   */
  retryAfter?: number;
  /**
   * What the person typed in the email field on the attempt that failed, so
   * the form comes back with it and they retype only the password.
   */
  email?: string;
  /**
   * The app whose authorization sent the person here, named so they know
   * what they are signing in for. Only ever one whose request the caller has
   * verified: the name is whatever the app registered, and a request nobody
   * signed would put a stranger's words on this page.
   */
  app?: { name: string };
}

const PASSKEY_STILL_WORKS = "or sign in with a passkey";

/** The id `PasswordField` gives its error, which the email field points at too. */
const PASSWORD_ERROR_ID = "sign-in-password-err";

/**
 * What a refused attempt says, under the password field. The
 * wrong-credentials line names neither the email nor the password, because
 * the server does not say which was wrong.
 */
function messageFor(error: string, retryAfter: number | undefined): string {
  switch (error) {
    case "invalid_credentials":
      return "That email or password is wrong.";
    case "missing_field":
      return "Enter your email and password.";
    case "too_many_attempts":
      return retryAfter === undefined
        ? `Too many attempts. Try again later, ${PASSKEY_STILL_WORKS}.`
        : `Too many attempts. Try again in ${waitInMinutes(retryAfter)}, ${PASSKEY_STILL_WORKS}.`;
    default:
      return "Something went wrong. Try again.";
  }
}

/** Renders the sign-in page as a complete HTML document string. */
export function renderSignInPage(params: SignInPageParams): string {
  const name = params.instanceName ?? DEFAULT_INSTANCE_NAME;
  const message =
    params.error !== undefined
      ? messageFor(params.error, params.retryAfter)
      : undefined;
  const typedEmail = params.email !== undefined && params.email !== "";
  // A wrong password does not say which of the two was wrong, and an empty
  // email is the one that is missing, so both read as invalid.
  const emailInvalid =
    params.error === "invalid_credentials" ||
    (params.error === "missing_field" && !typedEmail);

  const lede = params.app ? (
    <>
      Sign in to continue to <b>{params.app.name}</b>.
    </>
  ) : (
    params.address
  );

  return renderDocument(
    <PageShell title={`Sign in to ${name}`} nonce={params.nonce}>
      <MomentCard title={`Sign in to ${name}`} lede={lede}>
        {params.app !== undefined && (
          <Notice>
            Marfa hasn't verified this app. Anyone can use this name, so only
            allow access if you trust it.
          </Notice>
        )}
        <form
          class="stack"
          method="post"
          action="/auth/sign-in"
          novalidate
          data-sign-in
        >
          <input type="hidden" name="return_to" value={params.returnTo} />
          <TextField
            id="sign-in-email"
            name="email"
            label="Email"
            type="email"
            full
            required
            value={params.email ?? ""}
            autocomplete="username"
            autofocus={!typedEmail}
            invalidBy={emailInvalid ? PASSWORD_ERROR_ID : undefined}
          />
          <PasswordField
            id="sign-in-password"
            name="password"
            label="Password"
            full
            required
            autocomplete="current-password"
            autofocus={typedEmail}
            error={message}
          />
          <Button
            kind="primary"
            type="submit"
            wide
            loadingLabel="Signing in..."
          >
            Sign in
          </Button>
          <p class="small form-link">
            <a href={localHref("/auth/forgot-password")}>Forgot password?</a>
          </p>
        </form>
        <div class="stack" data-passkey-signin hidden>
          <Divider>or</Divider>
          <Button kind="outline" wide icon="passkey" hook="passkey-signin">
            Sign in with a passkey
          </Button>
          <div data-passkey-error tabindex={-1} hidden>
            <Notice tone="error">
              <span data-passkey-error-text></span>
            </Notice>
          </div>
        </div>
        <p class="small muted" data-passkey-unsupported hidden>
          Passkeys need a supported browser and a secure HTTPS address, or
          localhost.
        </p>
      </MomentCard>
    </PageShell>,
  );
}
