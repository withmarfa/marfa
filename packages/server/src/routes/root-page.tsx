/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * What a person sees when they open the server's address in a browser. A
 * program asking the same address gets the instance's JSON description, which
 * is what the address is for.
 */
import { DEFAULT_INSTANCE_NAME } from "../instance-name.js";
import { Button } from "../pages/parts/controls.js";
import { MomentCard } from "../pages/parts/layout.js";
import { PageShell } from "../pages/parts/shell.js";
import { renderDocument } from "../pages/render.js";

/** Renders the page a browser gets at the server's root. */
export function renderRootPage(
  nonce: string,
  instanceName = DEFAULT_INSTANCE_NAME,
): string {
  return renderDocument(
    <PageShell title={instanceName} nonce={nonce} needsScript={false}>
      <MomentCard
        title={`${instanceName} is running`}
        lede="This is a Marfa server. To use it, open an app and connect it to this address."
      >
        <Button kind="primary" wide href="/auth/sign-in">
          Sign in
        </Button>
      </MomentCard>
    </PageShell>,
  );
}
