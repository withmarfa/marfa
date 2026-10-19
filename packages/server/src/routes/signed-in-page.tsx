/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * What a person sees when they are signed in and there is nowhere further to
 * send them: at the server's address after signing in with no app waiting,
 * and when they open the sign-in page while a session already exists and no
 * authorization sent them.
 */
import { DEFAULT_INSTANCE_NAME } from "../instance-name.js";
import { renderDocument } from "../pages/render.js";
import { Button, MomentCard, PageShell } from "../pages/parts/index.js";

interface SignedInPageParams {
  instanceName?: string;
  /** The nonce the response's content security policy names. */
  nonce: string;
  /** The signed-in person's email, so the page says who. */
  email: string;
  /**
   * Where the person was headed when they arrived, already passed through
   * `validateReturnTo`. Offered as a link when it is somewhere other than the
   * instance's root.
   */
  continueTo?: string;
}

const TITLE = "You're signed in";

/** Renders the signed-in page as a full HTML document. */
export function renderSignedInPage(params: SignedInPageParams): string {
  const name = params.instanceName ?? DEFAULT_INSTANCE_NAME;
  const next =
    params.continueTo !== undefined && params.continueTo !== "/"
      ? params.continueTo
      : undefined;
  return renderDocument(
    <PageShell title={TITLE} nonce={params.nonce} needsScript={false}>
      <MomentCard
        title={TITLE}
        ledeRole="status"
        lede={
          <>
            You're signed in to {name} as <b>{params.email}</b>. To use your
            data, open an app and connect it to this server.
          </>
        }
      >
        {next !== undefined && (
          <Button kind="primary" wide href={next}>
            Continue
          </Button>
        )}
        <Button kind="outline" wide href="/auth/owner/manage">
          Manage {name}
        </Button>
      </MomentCard>
    </PageShell>,
  );
}
