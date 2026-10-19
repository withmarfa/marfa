/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * Connect a device: the screen where a signed-in person decides what a
 * device that showed them a code may do, and the page that ends it.
 *
 * It offers the same controls as Approve access (see {@link AccessChoices}),
 * built by the same model, and posts to `/auth/device/consent` with one
 * `scopes` field for each choice. It is a plain form: with scripting off it
 * posts the same way.
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

export interface DeviceConsentParams {
  instanceName?: string;
  /** The nonce the response's content security policy names. */
  nonce: string;
  clientName: string;
  /** The addresses approving lets reach the server, from `webOriginsOf`. */
  webOrigins?: readonly string[];
  scopes: ParsedScope[];
  /** The device's code, as normalized: eight letters and digits. */
  userCode: string;
  descriptions?: Record<string, string>;
  wildcardExpansions?: Record<string, string[]>;
  /** The consent the app already holds, or undefined for a first request. */
  priorScopes?: readonly string[];
  bundles?: PermissionBundle[];
}

/** Renders the Connect a device approval screen as an HTML document. */
export function renderDeviceConsentScreen(params: DeviceConsentParams): string {
  const model = buildAccess({
    scopes: params.scopes,
    held: params.priorScopes,
    descriptions: params.descriptions,
    wildcardExpansions: params.wildcardExpansions,
    bundles: params.bundles ?? getPermissionBundles(),
  });
  const instance = params.instanceName ?? DEFAULT_INSTANCE_NAME;
  return renderDocument(
    <PageShell
      title={`Connect ${params.clientName}`}
      nonce={params.nonce}
      needsScript={false}
    >
      <MomentCard
        title={`${params.clientName} wants access to ${instance}`}
        lede="Approve only if this code matches the one on your device."
        app={params.clientName}
      >
        <p class="code-tile">{params.userCode}</p>
        <UnverifiedAppNotice />
        <WebOriginNote origins={params.webOrigins ?? []} />
        <form
          class="stack"
          method="post"
          action="/auth/device/consent"
          novalidate
        >
          <input type="hidden" name="user_code" value={params.userCode} />
          <AccessChoices model={model} />
          <FormFoot note="If everything is off, approving denies the request.">
            <Button type="submit" kind="outline" name="decision" value="deny">
              Deny
            </Button>
            <Button
              type="submit"
              kind="primary"
              name="decision"
              value="approve"
            >
              Approve
            </Button>
          </FormFoot>
        </form>
      </MomentCard>
    </PageShell>,
  );
}

export interface DeviceDecisionParams {
  /** The nonce the response's content security policy names. */
  nonce: string;
  approved: boolean;
}

/** Renders the page that ends the approval, after a person approves or denies. */
export function renderDeviceDecisionPage(params: DeviceDecisionParams): string {
  const title = params.approved
    ? "Access approved"
    : "You didn't approve access";
  return renderDocument(
    <PageShell title={title} nonce={params.nonce} needsScript={false}>
      <MomentCard
        title={title}
        lede={
          params.approved
            ? "You're signed in. You can go back to your device."
            : "You can close this page."
        }
        ledeRole="status"
      />
    </PageShell>,
  );
}
