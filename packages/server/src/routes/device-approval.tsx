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
  NoEnterSubmit,
  CodeCells,
  ConfirmDialog,
  gateAttributes,
  MomentCard,
  PageShell,
} from "../pages/parts/index.js";
import type { ConfirmGate } from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";
import { AccessChoices } from "./access-choices.js";
import { ApprovalFoot, WebOriginNote } from "./access-notes.js";
import { buildAccess, describeFullAccess } from "./access-model.js";
import type { AccessInput } from "./access-model.js";
import type { ChoosableType } from "./access-types.js";

export interface DeviceConsentParams {
  instanceName?: string;
  /** The nonce the response's content security policy names. */
  nonce: string;
  clientName: string;
  /** The host that publishes the app's metadata document, from
   *  `metadataDocumentHost`. */
  clientSource?: string;
  /** The addresses approving lets reach the server, from `webOriginsOf`. */
  webOrigins?: readonly string[];
  scopes: ParsedScope[];
  /** The device's code, as normalized: eight letters and digits. */
  userCode: string;
  descriptions?: Record<string, string>;
  wildcardExpansions?: Record<string, string[]>;
  /** The label of each registered item type named, keyed by type id. */
  typeLabels?: Record<string, string>;
  /** The types a person may choose in place of all data, when the code names it. */
  chooseTypes?: readonly ChoosableType[];
  /** The consent the app already holds, or undefined for a first request. */
  priorScopes?: readonly string[];
  /** The email address of the person approving. */
  signedInAs?: string;
  bundles?: PermissionBundle[];
  /** Set where approving can need a sign-in newer than the person's. */
  confirmGate?: ConfirmGate;
}

/** Renders the Connect a device approval screen as an HTML document. */
export function renderDeviceConsentScreen(params: DeviceConsentParams): string {
  const input: AccessInput = {
    scopes: params.scopes,
    held: params.priorScopes,
    descriptions: params.descriptions,
    wildcardExpansions: params.wildcardExpansions,
    typeLabels: params.typeLabels,
    chooseTypes: params.chooseTypes,
    bundles: params.bundles ?? getPermissionBundles(),
  };
  const model = buildAccess(input);
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
        source={params.clientSource}
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
          data-approval
          novalidate
          {...gateAttributes(params.confirmGate)}
        >
          <input type="hidden" name="user_code" value={params.userCode} />
          <NoEnterSubmit />
          <AccessChoices
            model={model}
            approving={{
              app: params.clientName,
              full: describeFullAccess(input),
            }}
          />
          <WebOriginNote origins={params.webOrigins ?? []} />
          <ButtonPair>
            <Button type="submit" kind="outline" name="decision" value="deny">
              Cancel
            </Button>
            <Button
              type="submit"
              kind="primary"
              name="decision"
              value="approve"
              data={{ confirm: "" }}
            >
              Approve
            </Button>
          </ButtonPair>
        </form>
      </MomentCard>
      {params.confirmGate !== undefined && <ConfirmDialog />}
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
