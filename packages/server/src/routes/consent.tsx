/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * Approve access: the screen where a signed-in person decides what an app
 * that asked through the authorization flow may do.
 *
 * The form posts to `/auth/authorize/decision` with the signed request, and
 * one `scopes` field for each choice (see {@link AccessChoices}). It is a
 * plain form: with scripting off it posts the same way, and the script only
 * keeps its summary lines true as the choices change.
 */
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import { DEFAULT_INSTANCE_NAME } from "../instance-name.js";
import {
  Button,
  ButtonPair,
  MomentCard,
  PageShell,
} from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";
import { AccessChoices, offersChoice } from "./access-choices.js";
import {
  ApprovalFoot,
  EverythingOffNote,
  WebOriginNote,
} from "./access-notes.js";
import { buildAccess } from "./access-model.js";
import type { ChoosableType } from "./access-types.js";

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
  /** The label of each registered item type named, keyed by type id. */
  typeLabels?: Record<string, string>;
  /** The email address of the person approving. */
  signedInAs?: string;
  bundles?: PermissionBundle[];
  /** The types a person may choose in place of all data, when the request names it. */
  chooseTypes?: readonly ChoosableType[];
}

/** Renders the Approve access screen as an HTML document. */
export function renderConsentScreen(params: ConsentParams): string {
  const model = buildAccess({
    scopes: params.scopes,
    held: params.priorScopes,
    descriptions: params.descriptions,
    wildcardExpansions: params.wildcardExpansions,
    typeLabels: params.typeLabels,
    chooseTypes: params.chooseTypes,
    bundles: params.bundles ?? getPermissionBundles(),
  });
  const instance = params.instanceName ?? DEFAULT_INSTANCE_NAME;
  const asksForMore = offersChoice(model);
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
      enhancedByScript
    >
      <MomentCard
        title={title}
        lede={lede}
        app={params.clientName}
        foot={<ApprovalFoot />}
      >
        <form
          class="stack"
          method="post"
          action="/auth/authorize/decision"
          data-access
          novalidate
        >
          <input type="hidden" name="client_id" value={params.clientId} />
          <input type="hidden" name="oauth_query" value={params.oauthQuery} />
          <AccessChoices model={model} />
          <WebOriginNote origins={params.webOrigins ?? []} />
          {offersChoice(model) && <EverythingOffNote />}
          <ButtonPair>
            <Button type="submit" kind="outline" name="accept" value="false">
              Cancel
            </Button>
            <Button type="submit" kind="primary" name="accept" value="true">
              Approve
            </Button>
          </ButtonPair>
        </form>
      </MomentCard>
    </PageShell>,
  );
}
