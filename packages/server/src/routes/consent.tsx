/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * Approve access: the screen where a signed-in person decides what an app
 * that asked through the authorization flow may do.
 *
 * The form posts to `/auth/authorize/decision` with the signed request, and
 * one `scopes` field for each choice (see {@link AccessChoices}). It is a
 * plain form: with scripting off it posts the same way.
 */
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import { DEFAULT_INSTANCE_NAME } from "../instance-name.js";
import {
  Button,
  FormFoot,
  MomentCard,
  PageShell,
} from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";
import { AccessChoices } from "./access-choices.js";
import { UnverifiedAppNotice, WebOriginNote } from "./access-notes.js";
import { buildAccess } from "./access-model.js";

export interface ConsentParams {
  instanceName?: string;
  clientName: string;
  /** The addresses approving lets reach the server, from `webOriginsOf`. */
  webOrigins?: readonly string[];
  /** The nonce the response's content security policy names. */
  nonce: string;
  scopes: ParsedScope[];
  clientId: string;
  /** The full signed query the authorize endpoint forwarded, posted back unchanged. */
  oauthQuery: string;
  /** A sentence per type pattern, for a row the curated names do not explain. */
  descriptions?: Record<string, string>;
  /** The consent the app already holds, or undefined for a first request. */
  priorScopes?: readonly string[];
  /** The types an open-ended pattern matches today, keyed by pattern. */
  wildcardExpansions?: Record<string, string[]>;
  /** The email address of the person approving. */
  signedInAs?: string;
  bundles?: PermissionBundle[];
}

/** Renders the Approve access screen as an HTML document. */
export function renderConsentScreen(params: ConsentParams): string {
  const model = buildAccess({
    scopes: params.scopes,
    held: params.priorScopes,
    descriptions: params.descriptions,
    wildcardExpansions: params.wildcardExpansions,
    bundles: params.bundles ?? getPermissionBundles(),
  });
  const instance = params.instanceName ?? DEFAULT_INSTANCE_NAME;
  const asksForMore =
    model.data.length + model.profile.length + model.powers.length > 0;
  const title = !model.returning
    ? `${params.clientName} wants access to ${instance}`
    : asksForMore
      ? `${params.clientName} wants more access`
      : `${params.clientName} wants to confirm its access`;
  const lede = model.returning
    ? asksForMore
      ? "It already has access to some of your data."
      : "It already has all of this."
    : params.signedInAs !== undefined
      ? `Signed in as ${params.signedInAs}`
      : undefined;
  return renderDocument(
    <PageShell
      title={
        model.returning
          ? `Update access for ${params.clientName}`
          : `Authorize ${params.clientName}`
      }
      nonce={params.nonce}
      needsScript={false}
    >
      <MomentCard title={title} lede={lede} app={params.clientName}>
        <UnverifiedAppNotice />
        <WebOriginNote origins={params.webOrigins ?? []} />
        <form
          class="stack"
          method="post"
          action="/auth/authorize/decision"
          novalidate
        >
          <input type="hidden" name="client_id" value={params.clientId} />
          <input type="hidden" name="oauth_query" value={params.oauthQuery} />
          <AccessChoices model={model} />
          <FormFoot note="If everything is off, approving denies the request.">
            <Button type="submit" kind="outline" name="accept" value="false">
              Deny
            </Button>
            <Button type="submit" kind="primary" name="accept" value="true">
              Approve
            </Button>
          </FormFoot>
        </form>
      </MomentCard>
    </PageShell>,
  );
}
