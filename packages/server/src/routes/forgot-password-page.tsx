/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The page a person reaches from "Forgot password?" on the sign-in page.
 *
 * Marfa has no reset by email. The owner's password is recovered with the
 * `marfa owner recover` command through the instance's private socket, which
 * only a process on the machine that runs the server, under the account that
 * runs it, can reach. The server does not know whether it runs on a Mac, in
 * Docker or on a hosted service, so the page gives the steps for each.
 *
 * The page is public and fixed: it renders nothing from the request and
 * nothing about this machine, such as the socket's path.
 */
import { renderDocument } from "../pages/render.js";
import {
  Button,
  CommandBlock,
  MomentCard,
  PageShell,
} from "../pages/parts/index.js";

const TITLE = "Reset your password";

/** On a Mac or another computer, `PATH` is the private socket the server logs when it starts. */
const COMPUTER_COMMAND = "marfa --socket PATH owner recover";

/** In Docker, the image keeps the socket at the same path in every container. */
const DOCKER_COMMAND =
  "docker exec -it marfa marfa --socket /data/control/marfa.sock owner recover";

/** On Railway, the service's environment already names the socket. */
const HOSTED_COMMAND = 'marfa --socket "$MARFA_CONTROL_SOCKET" owner recover';

/** Renders the forgot-password page as a complete HTML document string. */
export function renderForgotPasswordPage(nonce: string): string {
  return renderDocument(
    <PageShell title={TITLE} nonce={nonce}>
      <MomentCard
        title={TITLE}
        lede="Marfa sends no email, so you reset your password on the machine Marfa runs on."
      >
        <div class="stack">
          <p class="strong">If Marfa runs on your Mac</p>
          <p>
            In Terminal, as the user account that runs Marfa, run this. Replace{" "}
            <code>PATH</code> with the private socket, which is{" "}
            <code>control/marfa.sock</code> in the folder that holds Marfa's
            database.
          </p>
          <CommandBlock command={COMPUTER_COMMAND} />
        </div>
        <div class="stack">
          <p class="strong">If Marfa runs in Docker</p>
          <p>
            In a terminal on the machine that runs Docker, run this. If you
            named the container something other than <code>marfa</code>, use
            that name in its place.
          </p>
          <CommandBlock command={DOCKER_COMMAND} />
        </div>
        <div class="stack">
          <p class="strong">If Marfa runs on Railway</p>
          <p>
            Connect to the Marfa service with Railway SSH, which the service's
            menu in the Railway dashboard copies for you. Then run this inside
            it.
          </p>
          <CommandBlock command={HOSTED_COMMAND} />
        </div>
        <p class="small muted">
          The command asks for a new password, then signs you out of every
          browser and lifts any password lock. Connected apps, keys and passkeys
          keep working.
        </p>
        <Button kind="outline" wide href="/auth/sign-in">
          Back to sign in
        </Button>
      </MomentCard>
    </PageShell>,
  );
}
