/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Button, DangerRow, Dialog, Notice } from "../pages/parts/index.js";
import type { ItemSummary } from "../storage/interface.js";
export function ItemAction(props: {
  item: ItemSummary;
  action: "trash" | "restore" | "purge";
}) {
  const label =
    props.action === "trash"
      ? "Move to trash"
      : props.action === "restore"
        ? "Restore"
        : "Delete for good";
  const data = {
    "item-change": props.action,
    "item-id": props.item.id,
    "item-version": String(props.item.version),
  };
  if (props.action !== "purge")
    return (
      <Button kind="quiet" label={`${label}: ${props.item.name}`} data={data}>
        {label}
      </Button>
    );
  const id = `purge-${props.item.id}`;
  return (
    <>
      <Button
        kind="danger-quiet"
        opens={id}
        label={`${label}: ${props.item.name}`}
      >
        {label}
      </Button>
      <Dialog
        id={id}
        title={`Delete “${props.item.name}” for good?`}
        description="This item and its links will be deleted permanently. This can't be undone."
        actions={
          <>
            <Button kind="outline" closes>
              Cancel
            </Button>
            <Button kind="danger" data={data}>
              Delete for good
            </Button>
          </>
        }
      >
        <ChangeNotice />
      </Dialog>
    </>
  );
}
export function ChangeNotice() {
  return (
    <div data-item-problem hidden>
      <Notice tone="error">
        <span data-item-problem-text />
      </Notice>
    </div>
  );
}
export function EmptyTrashAction() {
  return (
    <>
      <Button kind="danger-quiet" opens="empty-trash">
        Empty trash
      </Button>
      <Dialog
        id="empty-trash"
        title="Empty the trash?"
        description="Everything in the trash will be deleted permanently. This can't be undone."
        actions={
          <>
            <Button kind="outline" closes>
              Cancel
            </Button>
            <Button kind="danger" data={{ "item-change": "empty" }}>
              Empty trash
            </Button>
          </>
        }
      >
        <ChangeNotice />
      </Dialog>
    </>
  );
}
export function RemoveTypeAction(props: { id: string; reason?: string }) {
  return (
    <>
      <DangerRow
        title="Remove this type"
        description={
          props.reason ?? "Nothing uses this type. Removing it can't be undone."
        }
        action={
          <Button
            kind="danger-quiet"
            ariaDisabled={!!props.reason}
            opens={props.reason ? undefined : "remove-type"}
          >
            Remove type
          </Button>
        }
      />
      {!props.reason && (
        <Dialog
          id="remove-type"
          title="Remove this type?"
          description="Nothing uses this type. Removing it can't be undone."
          actions={
            <>
              <Button kind="outline" closes>
                Cancel
              </Button>
              <Button
                kind="danger"
                data={{ "item-change": "type", "item-id": props.id }}
              >
                Remove type
              </Button>
            </>
          }
        >
          <ChangeNotice />
        </Dialog>
      )}
    </>
  );
}
