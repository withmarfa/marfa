/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { TypeSchema } from "@withmarfa/shared";
import type { ItemSummary } from "../storage/interface.js";
import {
  PAGE_SIZE,
  type PageSize,
  type Pagination,
} from "../pages/navigation.js";
import {
  Button,
  ConsolePage,
  EmptyState,
  ListToolbar,
  LocalDate,
  PageHeader,
  Pager,
  Row,
  RowGroup,
  SearchField,
  Section,
  Select,
} from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";
import { pluralNoun } from "./scope-copy.js";

export const ITEMS_HREF = "/auth/owner/items";
export const typeHref = (id: string) =>
  `/auth/owner/types/${encodeURIComponent(id)}`;
export interface ItemView {
  type?: string;
  query?: string;
  page?: number;
  size?: PageSize;
}
export function itemsHref(view: ItemView = {}) {
  const q = new URLSearchParams();
  if (view.type) q.set("type", view.type);
  if (view.query) q.set("q", view.query);
  if (view.page && view.page > 1) q.set("page", String(view.page));
  if (view.size && view.size !== PAGE_SIZE) q.set("size", String(view.size));
  return q.size ? `${ITEMS_HREF}?${q.toString()}` : ITEMS_HREF;
}
export interface ItemType {
  schema: Pick<TypeSchema, "id" | "label" | "description">;
  count: number;
  plural: string;
}
export function typePlural(type: ItemType["schema"]): string {
  const label = type.label ?? type.id;
  if (!type.id.startsWith("core.")) return label;
  const plural = pluralNoun(label);
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}
function typeInSentence(type: ItemType): string {
  return type.schema.id.startsWith("core.")
    ? type.plural.toLowerCase()
    : type.plural;
}
interface PageBase {
  nonce: string;
  instanceName: string;
  types: ItemType[];
}
export interface ItemsPageParams extends PageBase {
  view: ItemView;
  total: number;
  files: string;
  groups: { type: ItemType; rows: ItemSummary[] }[];
  rows?: ItemSummary[];
  pagination?: Pagination;
}
const siblings = (types: ItemType[]) => ({
  items: types.map((t) => ({
    title: t.schema.label ?? t.schema.id,
    href: typeHref(t.schema.id),
  })),
});
function ItemRows(props: { rows: ItemSummary[] }) {
  return (
    <>
      {props.rows.map((row) => (
        <Row
          title={row.name}
          description={
            <>
              Added by {row.source || "an unknown source"} on{" "}
              <LocalDate at={new Date(row.created_at)} />.
            </>
          }
        />
      ))}
    </>
  );
}
function Breakdown(props: { types: ItemType[]; total: number }) {
  const parts = props.types
    .filter((t) => t.count > 0)
    .slice(0, 4)
    .map((t) => ({ label: t.plural, count: t.count }));
  const rest = props.total - parts.reduce((n, p) => n + p.count, 0);
  if (rest) parts.push({ label: "Other types", count: rest });
  let offset = 0;
  return (
    <div class="item-breakdown">
      <div>
        <strong class="item-total">
          {props.total.toLocaleString("en-US")}
        </strong>{" "}
        <span class="muted">items</span>
      </div>
      <svg
        class="item-share"
        viewBox="0 0 1000 12"
        preserveAspectRatio="none"
        role="img"
        aria-label={parts
          .map((p) => `${p.label}: ${String(p.count)}`)
          .join(", ")}
      >
        {parts.map((part, i) => {
          const width = (part.count / props.total) * 1000;
          const x = offset;
          offset += width;
          return (
            <rect
              class={`item-share-${String(i)}`}
              x={x}
              width={width}
              y="0"
              height="12"
            />
          );
        })}
      </svg>
      <div class="item-legend">
        {parts.map((part, i) => (
          <span>
            <span class={`item-swatch item-share-${String(i)}`} />
            {part.label}{" "}
            <span class="muted">{part.count.toLocaleString("en-US")}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
export function renderItemsPage(props: ItemsPageParams) {
  const selected = props.types.find((t) => t.schema.id === props.view.type);
  const present = props.types.filter((t) => t.count > 0 || t === selected);
  const options = (core: boolean) =>
    present
      .filter((t) => t.schema.id.startsWith("core.") === core)
      .map((t) => ({ value: t.schema.id, label: t.plural }));
  return renderDocument(
    <ConsolePage
      title="Items"
      nonce={props.nonce}
      instanceName={props.instanceName}
      pageId="items"
      trail={[{ label: "Items" }]}
      items={siblings(props.types)}
    >
      <div class="stack-24">
        <PageHeader
          title="Items"
          lede="Everything in Marfa, by type, and where each item came from. To read or change an item, open an app that uses it."
        />
        {props.total > 0 && (
          <Section
            id="summary"
            title="Summary"
            description={`${props.files}. Items in the trash aren't counted.`}
          >
            <RowGroup>
              <Breakdown types={props.types} total={props.total} />
            </RowGroup>
          </Section>
        )}
        {props.total === 0 && !props.view.type && !props.view.query ? (
          <RowGroup>
            <EmptyState
              title="No items yet"
              description="Items appear here as apps, connectors and folders add them."
            />
          </RowGroup>
        ) : (
          <>
            <ListToolbar
              action={ITEMS_HREF}
              label="Find items"
              filters={
                <Select
                  name="type"
                  label="Type"
                  value={props.view.type ?? ""}
                  autosubmit
                  options={[
                    { value: "", label: "All types" },
                    ...(options(true).length
                      ? [{ label: "Built in", options: options(true) }]
                      : []),
                    ...(options(false).length
                      ? [
                          {
                            label: "Added by apps and you",
                            options: options(false),
                          },
                        ]
                      : []),
                  ]}
                />
              }
              search={
                <SearchField
                  name="q"
                  value={props.view.query ?? ""}
                  placeholder="Search items"
                />
              }
            />
            {selected && (
              <RowGroup>
                <Row
                  title={`About ${typeInSentence(selected)}`}
                  description={
                    selected.schema.id.startsWith("core.")
                      ? "Built in"
                      : "Added to this Marfa"
                  }
                  href={typeHref(selected.schema.id)}
                />
              </RowGroup>
            )}
            {props.rows ? (
              <Section
                id="item-list"
                title={
                  props.view.query
                    ? "Search results"
                    : (selected?.plural ?? "Items")
                }
                description={
                  props.view.query
                    ? `Names matching “${props.view.query}”.`
                    : selected?.schema.description
                }
              >
                <div class="stack">
                  <RowGroup oneLine>
                    {props.rows.length ? (
                      <ItemRows rows={props.rows} />
                    ) : (
                      <EmptyState
                        title={props.view.query ? "No results" : "No items"}
                        description={
                          props.view.query
                            ? `Nothing matches “${props.view.query}”.`
                            : "Items of this type appear here when they are added."
                        }
                      />
                    )}
                  </RowGroup>
                  {props.pagination && (
                    <Pager
                      pagination={props.pagination}
                      noun="items"
                      open={Boolean(props.view.query)}
                      carry={{
                        ...(props.view.type ? { type: props.view.type } : {}),
                        ...(props.view.query ? { q: props.view.query } : {}),
                      }}
                      href={(page) => itemsHref({ ...props.view, page })}
                    />
                  )}
                </div>
              </Section>
            ) : (
              props.groups.map((group) => (
                <Section
                  id={group.type.schema.id}
                  title={group.type.plural}
                  description={`${String(group.type.count)} in Marfa. ${group.type.schema.description ?? ""}`}
                >
                  <RowGroup oneLine>
                    <ItemRows rows={group.rows} />
                    {group.type.count > 3 && (
                      <Row
                        title={`See all ${String(group.type.count)} ${typeInSentence(group.type)}`}
                        href={itemsHref({ type: group.type.schema.id })}
                      />
                    )}
                  </RowGroup>
                </Section>
              ))
            )}
          </>
        )}
      </div>
    </ConsolePage>,
  );
}
export function renderTypePage(
  props: PageBase & { schema?: TypeSchema; count: number; trashed: number },
) {
  const type = props.schema;
  const title = type?.label ?? type?.id ?? "Type";
  return renderDocument(
    <ConsolePage
      title={title}
      nonce={props.nonce}
      instanceName={props.instanceName}
      pageId="items"
      trail={[{ label: "Items", href: ITEMS_HREF }, { label: title }]}
      items={siblings(props.types)}
      currentItemHref={type && typeHref(type.id)}
    >
      <div class="stack-24">
        <PageHeader
          title={type ? title : "That type isn't here"}
          lede={type?.description}
        />
        {type ? (
          <Section
            id="details"
            title="Details"
            description={
              type.id.startsWith("core.")
                ? "Every Marfa has this type. It can't be changed or removed."
                : "Added to this Marfa. Its fields are set by what added it."
            }
          >
            <RowGroup>
              <Row title="Type name" value={type.id} valueAuto />
              <Row
                title="Added by"
                value={type.id.startsWith("core.") ? "Marfa" : "Not recorded"}
              />
              <Row
                title="Required fields"
                value={
                  Object.entries(type.fields)
                    .filter(([, field]) => field.required)
                    .map(([name]) => name.replaceAll("_", " "))
                    .join(", ") || "None"
                }
                valueAuto
              />
              <Row
                title="Items"
                value={String(props.count)}
                href={itemsHref({ type: type.id })}
              />
              {props.trashed > 0 && (
                <Row title="In the trash" value={String(props.trashed)} />
              )}
            </RowGroup>
          </Section>
        ) : (
          <RowGroup>
            <EmptyState
              title="It may have been removed"
              action={
                <Button href={ITEMS_HREF} kind="outline">
                  Go back
                </Button>
              }
            />
          </RowGroup>
        )}
      </div>
    </ConsolePage>,
  );
}
