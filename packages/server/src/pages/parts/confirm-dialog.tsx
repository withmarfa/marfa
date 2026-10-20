/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { pageAssetUrl } from "../assets.js";
import { Button } from "./controls.js";
import { Dialog } from "./dialog.js";
import { Notice } from "./feedback.js";
import { PasswordField } from "./fields.js";

/** The id of the form the dialog's Continue button sends. */
const FORM_ID = "confirm-form";

/**
 * "Confirm it's you": the dialog a page opens when a change is refused for a
 * sign-in older than five minutes. The person proves they are there with a
 * passkey or the password, and the page then sends the change again. The
 * browser module `confirm.ts` drives it; the page puts it once at the end of
 * its body and asks nothing else of it.
 */
export function ConfirmDialog() {
  return (
    <Dialog
      id="confirm-dialog"
      title="Confirm it's you"
      description={
        <>
          <span data-confirm-why></span> Changes like this need a sign-in from
          the last 5 minutes.
        </>
      }
      data={{ "confirm-dialog": "" }}
      actions={
        <>
          <Button kind="outline" closes>
            Cancel
          </Button>
          <Button
            kind="primary"
            type="submit"
            form={FORM_ID}
            hook="confirm-continue"
            loadingLabel="Checking..."
          >
            Continue
          </Button>
        </>
      }
    >
      <form class="stack" id={FORM_ID} data-confirm-form novalidate>
        <Button
          kind="outline"
          wide
          icon="passkey"
          hook="confirm-passkey"
          hidden
        >
          Use a passkey
        </Button>
        <div data-confirm-passkey-error tabindex={-1} hidden>
          <Notice tone="error">
            <span data-confirm-passkey-error-text></span>
          </Notice>
        </div>
        <PasswordField
          id="confirm-password"
          name="password"
          label="Or your password"
          full
          autocomplete="current-password"
        />
      </form>
    </Dialog>
  );
}

/**
 * The dialog for a page with a stylesheet of its own, which the page system's
 * styles would otherwise collide with. It sits in a shadow root that loads the
 * page system's stylesheet, so the page keeps its look and the dialog keeps
 * its. Pages built on the page system render {@link ConfirmDialog} directly.
 */
export function ConfirmDialogHost(props: { nonce: string }) {
  return (
    <div data-confirm-host>
      <template shadowrootmode="open">
        <link
          rel="stylesheet"
          href={pageAssetUrl("pages.css")}
          nonce={props.nonce}
        />
        <ConfirmDialog />
      </template>
    </div>
  );
}

/**
 * What a form needs for its approve button to open the dialog first, when the
 * sign-in has gone stale by the time the person presses it.
 */
export interface ConfirmGate {
  /** Milliseconds from now until the sign-in stops counting as recent. */
  left: number;
  /** The scopes the form offers whose approval needs a recent sign-in. */
  scopes: readonly string[];
  /** The line the dialog says about the change, before the sign-in time. */
  why: string;
}

/** The attributes that make a form open the dialog, or none without a gate. */
export function gateAttributes(
  gate: ConfirmGate | undefined,
): Record<string, string> {
  if (gate === undefined) return {};
  return {
    "data-confirm-left": String(Math.max(0, Math.round(gate.left))),
    "data-confirm-scopes": gate.scopes.join(" "),
    "data-confirm-why": gate.why,
  };
}
