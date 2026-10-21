/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { TrashSummary } from "../storage/interface.js";
import type { paginate } from "../pages/navigation.js";
import {
  ConsolePage,
  DangerRow,
  EmptyState,
  ListToolbar,
  LocalDate,
  PageHeader,
  Pager,
  Row,
  RowGroup,
  SearchField,
  Select,
  Section,
} from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";
import { ChangeNotice, EmptyTrashAction, ItemAction } from "./item-actions.js";
import { trashEligibleAt } from "../trash-retention.js";
const HREF = "/auth/owner/trash";
export function TrashPage({
  nonce,
  instanceName,
  total,
  days,
  type,
  q,
  counts,
  label,
  data,
  pagination,
  href,
}: {
  nonce: string;
  instanceName: string;
  total: number;
  days: number;
  type?: string;
  q: string;
  counts: Record<string, number>;
  label: (id: string) => string;
  data: TrashSummary[];
  pagination: ReturnType<typeof paginate>;
  href: (at: number) => string;
}) {
  return renderDocument(
    <ConsolePage
      title="Trash"
      nonce={nonce}
      instanceName={instanceName}
      pageId="trash"
      trail={[{ label: "Trash" }]}
    >
      <div class="stack-24" data-item-actions>
        <PageHeader
          title="Trash"
          lede={
            days
              ? `Items stay in the trash for ${String(days)} days before becoming eligible for automatic deletion. A later sweep deletes them for good.`
              : "Items stay in the trash until you delete them."
          }
        />
        <ChangeNotice />
        <div data-item-flash hidden role="status" />
        {total === 0 ? (
          <RowGroup>
            <EmptyState
              title="The trash is empty"
              description="Items you or your apps delete wait here, so you can restore them."
            />
          </RowGroup>
        ) : (
          <>
            <ListToolbar
              action={HREF}
              label="Find trashed items"
              filters={
                <Select
                  name="type"
                  label="Type"
                  value={type ?? ""}
                  autosubmit
                  options={[
                    { value: "", label: "All types" },
                    ...Object.keys(counts).map((id) => ({
                      value: id,
                      label: label(id),
                    })),
                  ]}
                />
              }
              search={
                <SearchField name="q" value={q} placeholder="Search trash" />
              }
            />
            <Section
              id="trash-list"
              title={
                q ? "Search results" : type ? label(type) : "Items in the trash"
              }
            >
              <div class="stack">
                <RowGroup>
                  {data.length ? (
                    data.map((row) => {
                      const eligibleAt = trashEligibleAt(row.trashed_at, days);
                      return (
                        <Row
                          title={row.name}
                          description={
                            <>
                              {label(row.type)}. Deleted by{" "}
                              {row.trashed_by?.name ?? "an unrecorded source"}
                              {row.trashed_at ? (
                                <>
                                  {" "}
                                  on <LocalDate at={new Date(row.trashed_at)} />
                                </>
                              ) : (
                                ""
                              )}
                              .{" "}
                              {days === 0 ? (
                                "Automatic deletion is off."
                              ) : eligibleAt ? (
                                <>
                                  Eligible for automatic deletion from{" "}
                                  <LocalDate at={new Date(eligibleAt)} />.
                                </>
                              ) : (
                                "Automatic deletion date unknown."
                              )}
                            </>
                          }
                          buttons={
                            <>
                              <ItemAction item={row} action="restore" />
                              <ItemAction item={row} action="purge" />
                            </>
                          }
                        />
                      );
                    })
                  ) : (
                    <EmptyState
                      title="No results"
                      description="No trashed item names match these filters."
                    />
                  )}
                </RowGroup>
                <Pager
                  pagination={pagination}
                  noun="items"
                  open={!!q}
                  carry={{
                    ...(type ? { type } : {}),
                    ...(q ? { q } : {}),
                  }}
                  href={href}
                />
              </div>
            </Section>
          </>
        )}
        {total > 0 && (
          <DangerRow
            title="Empty the trash"
            description="Everything in the trash will be deleted for good. This can't be undone."
            action={<EmptyTrashAction />}
          />
        )}
      </div>
    </ConsolePage>,
  );
}
