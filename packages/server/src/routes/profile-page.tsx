/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * Profile: the owner's name and email, each changed in a dialog. The change
 * itself is made by the browser module `client/account.ts` through
 * `PATCH /owner`, which checks the values and asks for a recent sign-in.
 */
import { renderDocument } from "../pages/render.js";
import {
  Button,
  ConsolePage,
  Dialog,
  Notice,
  PageHeader,
  Row,
  RowGroup,
  TextField,
} from "../pages/parts/index.js";

export const PROFILE_HREF = "/auth/owner/profile";

export interface ProfilePageParams {
  nonce: string;
  instanceName: string;
  owner: { name: string; email: string };
}

function ChangeDialog(props: {
  kind: "name" | "email";
  title: string;
  description: string;
  label: string;
  value: string;
}) {
  const formId = `profile-${props.kind}-form`;
  return (
    <Dialog
      id={`profile-${props.kind}-dialog`}
      title={props.title}
      description={props.description}
      actions={
        <>
          <Button kind="outline" closes>
            Cancel
          </Button>
          <Button
            kind="primary"
            type="submit"
            form={formId}
            loadingLabel="Saving..."
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        method="dialog"
        novalidate
        data-account-form={props.kind}
        data-refresh=""
        data-after={`change-${props.kind}`}
      >
        <TextField
          id={`profile-${props.kind}-input`}
          name={props.kind}
          label={props.label}
          type={props.kind === "email" ? "email" : "text"}
          value={props.value}
          autocomplete={props.kind}
          full
        />
      </form>
    </Dialog>
  );
}

export function ProfilePage(props: ProfilePageParams) {
  return (
    <ConsolePage
      title="Profile"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Profile" }]}
      pageId="profile"
    >
      <div class="stack-24">
        <PageHeader
          title="Profile"
          lede="Your name and email. Apps see them only if you let them."
        />
        <div data-notice="done" hidden>
          <Notice>
            <span data-notice-text></span>
          </Notice>
        </div>
      </div>
      <div data-live>
        <RowGroup>
          <Row
            id="profile-name"
            title="Name"
            description={props.owner.name}
            buttons={
              <Button
                kind="quiet"
                opens="profile-name-dialog"
                hook="change-name"
              >
                Change
              </Button>
            }
          />
          <Row
            id="profile-email"
            title="Email"
            description={`${props.owner.email}. You sign in with it.`}
            buttons={
              <Button
                kind="quiet"
                opens="profile-email-dialog"
                hook="change-email"
              >
                Change
              </Button>
            }
          />
        </RowGroup>
        <ChangeDialog
          kind="name"
          title="Change name"
          description="Shown to apps you let see your profile."
          label="Name"
          value={props.owner.name}
        />
        <ChangeDialog
          kind="email"
          title="Change email"
          description="You sign in with this email. Marfa sends no email, so there's nothing to confirm."
          label="Email"
          value={props.owner.email}
        />
      </div>
    </ConsolePage>
  );
}

export function renderProfilePage(params: ProfilePageParams): string {
  return renderDocument(<ProfilePage {...params} />);
}
