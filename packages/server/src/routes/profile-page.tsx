/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { renderDocument } from "../pages/render.js";
import {
  Button,
  ConsolePage,
  Dialog,
  FileField,
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
  owner: { name: string; email: string; hasPicture: boolean };
}

/** Where the owner's picture is served, as this page's own address. */
const PICTURE_PATH = "/owner/picture";

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

function PictureDialog() {
  return (
    <Dialog
      id="profile-avatar-dialog"
      title="Change picture"
      description="Choose a PNG, JPEG or WebP picture of 2 MiB or less."
      actions={
        <>
          <Button kind="outline" closes>
            Cancel
          </Button>
          <Button
            kind="primary"
            type="submit"
            form="profile-avatar-form"
            loadingLabel="Saving..."
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id="profile-avatar-form"
        method="dialog"
        novalidate
        data-account-form="avatar"
        data-refresh=""
        data-after="change-avatar"
      >
        <FileField
          id="profile-avatar-input"
          name="avatar"
          label="Picture"
          accept="image/png,image/jpeg,image/webp"
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
          lede="Your name, email and picture. Apps see them only if you let them."
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
          <Row
            id="profile-avatar"
            title="Picture"
            description={
              props.owner.hasPicture ? "Picture set" : "No picture set"
            }
            buttons={
              <>
                {props.owner.hasPicture ? (
                  <img
                    class="avatar"
                    src={PICTURE_PATH}
                    alt=""
                    width="32"
                    height="32"
                  />
                ) : (
                  <span class="tile" aria-hidden="true">
                    {Array.from(
                      props.owner.name || props.owner.email,
                    )[0]?.toUpperCase() ?? "?"}
                  </span>
                )}
                {props.owner.hasPicture && (
                  <Button kind="quiet" hook="remove-avatar">
                    Remove picture
                  </Button>
                )}
                <Button
                  kind="quiet"
                  opens="profile-avatar-dialog"
                  hook="change-avatar"
                >
                  Change
                </Button>
              </>
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
        <PictureDialog />
      </div>
    </ConsolePage>
  );
}

export function renderProfilePage(params: ProfilePageParams): string {
  return renderDocument(<ProfilePage {...params} />);
}
