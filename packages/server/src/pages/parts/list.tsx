/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { localHref } from "../href.js";
import { Icon } from "../icons.js";
import { PAGE_SIZE, PAGE_SIZES, type Pagination } from "../navigation.js";
import { Select } from "./controls.js";

export interface ListToolbarProps {
  /** Where the filters and the search send the list. */
  action?: string;
  /** Selects or tabs, on the left. */
  filters?: Child;
  /** A `SearchField`, on the right. With no filters it takes the row. */
  search: Child;
  /** The accessible name of the search region. */
  label?: string;
}

/** A GET form, so a filtered, searched list has an address of its own. */
export function ListToolbar(props: ListToolbarProps) {
  return (
    <form
      class="toolbar"
      method="get"
      action={props.action}
      role="search"
      aria-label={props.label}
    >
      {props.filters !== undefined && (
        <div class="filters">{props.filters}</div>
      )}
      {props.search}
    </form>
  );
}

export interface PagerProps {
  pagination: Pagination;
  /** The address of page `n` of this list, at the size it is shown in now. */
  href: (page: number) => string;
  /** What the rows are, in the plural: "keys". */
  noun: string;
  /**
   * The rest of the list's query (its search and filters), which choosing
   * another size sends back. Page and size are never carried.
   */
  carry?: Readonly<Record<string, string>>;
}

/**
 * Under a long list: the "Rows per page" select on the left (10, 25 or 50,
 * sent as `size`), and where you are with the arrows on the right. A list of
 * ten rows or fewer shows none, because no size changes what it shows. The
 * select sends its form when it changes, which takes a script, so the form
 * starts hidden and the script shows it.
 */
export function Pager(props: PagerProps) {
  const { pagination: p } = props;
  if (p.total <= PAGE_SIZE) return null;
  const range = `${String(p.from + 1)}–${String(p.to)} of ${String(p.total)}`;
  return (
    <nav class="pager" aria-label={`${props.noun}, pages`}>
      <form class="line" method="get" data-script-only hidden>
        {Object.entries(props.carry ?? {})
          .filter(([name]) => name !== "size" && name !== "page")
          .map(([name, value]) => (
            <input type="hidden" name={name} value={value} />
          ))}
        <label class="line">
          <span class="muted">Rows per page</span>
          <Select
            name="size"
            label="Rows per page"
            value={String(p.size)}
            auto
            autosubmit
            options={PAGE_SIZES.map((size) => ({
              value: String(size),
              label: String(size),
            }))}
          />
        </label>
      </form>
      <div class="line">
        <span class="muted">{range}</span>
        {p.hasPrevious ? (
          <a
            class="btn icon-only"
            href={localHref(props.href(p.page - 1), { relative: true })}
            rel="prev"
            aria-label="Previous page"
            title="Previous page"
          >
            <Icon name="back" />
          </a>
        ) : (
          <span
            class="btn icon-only"
            aria-disabled="true"
            role="link"
            aria-label="Previous page"
          >
            <Icon name="back" />
          </span>
        )}
        {p.hasNext ? (
          <a
            class="btn icon-only"
            href={localHref(props.href(p.page + 1), { relative: true })}
            rel="next"
            aria-label="Next page"
            title="Next page"
          >
            <Icon name="chevron" />
          </a>
        ) : (
          <span
            class="btn icon-only"
            aria-disabled="true"
            role="link"
            aria-label="Next page"
          >
            <Icon name="chevron" />
          </span>
        )}
      </div>
    </nav>
  );
}

export interface TabsProps {
  /** What the tabs split: "Keys". */
  label: string;
  tabs: readonly {
    label: string;
    href: string;
    current: boolean;
    count?: number;
  }[];
}

/** Two or three kinds of one list. Each is a link, so the choice is in the address. */
export function Tabs(props: TabsProps) {
  return (
    <nav class="tabs" aria-label={props.label}>
      {props.tabs.map((tab) => (
        <a
          class="tab"
          href={localHref(tab.href, { relative: true })}
          aria-current={tab.current ? "true" : undefined}
        >
          {tab.label}
          {tab.count !== undefined && <span class="n">{tab.count}</span>}
        </a>
      ))}
    </nav>
  );
}
