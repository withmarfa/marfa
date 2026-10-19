/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * Connect a device: the screen where a signed-in person decides what a
 * device that showed them a code may do, and the page that ends it.
 *
 * It offers the same controls as Approve access (see {@link AccessChoices}),
 * built by the same model, and posts to `/auth/device/consent` with one
 * `scopes` field for each choice. It is a plain form: with scripting off it
 * posts the same way, and the script only keeps its summary lines true as the
 * choices change.
 */
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import { DEFAULT_INSTANCE_NAME } from "../instance-name.js";
import {
  Button,
  ButtonPair,
  CodeCells,
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
  /** The label of each registered item type named, keyed by type id. */
  typeLabels?: Record<string, string>;
  /** The consent the app already holds, or undefined for a first request. */
  priorScopes?: readonly string[];
  /** The email address of the person approving. */
  signedInAs?: string;
  bundles?: PermissionBundle[];
}

/** Renders the Connect a device approval screen as an HTML document. */
export function renderDeviceConsentScreen(params: DeviceConsentParams): string {
  const model = buildAccess({
    scopes: params.scopes,
    held: params.priorScopes,
    descriptions: params.descriptions,
    wildcardExpansions: params.wildcardExpansions,
    typeLabels: params.typeLabels,
    bundles: params.bundles ?? getPermissionBundles(),
  });
  const instance = params.instanceName ?? DEFAULT_INSTANCE_NAME;
  return renderDocument(
    <PageShell
      title={`Connect ${params.clientName}`}
      nonce={params.nonce}
      needsScript={false}
      enhancedByScript
    >
      <MomentCard
        title={`${params.clientName} wants access to ${instance}`}
        lede={
          params.signedInAs !== undefined
            ? `Signed in as ${params.signedInAs}`
            : undefined
        }
        app={params.clientName}
        foot={<ApprovalFoot />}
      >
        <CodeCells
          code={params.userCode}
          caption="Check this code matches your device"
        />
        <form
          class="stack"
          method="post"
          action="/auth/device/consent"
          data-access
          novalidate
        >
          <input type="hidden" name="user_code" value={params.userCode} />
          <AccessChoices model={model} />
          <WebOriginNote origins={params.webOrigins ?? []} />
          {offersChoice(model) && <EverythingOffNote />}
          <ButtonPair>
            <Button type="submit" kind="outline" name="decision" value="deny">
              Cancel
            </Button>
            <Button
              type="submit"
              kind="primary"
              name="decision"
              value="approve"
            >
              Approve
            </Button>
          </ButtonPair>
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
