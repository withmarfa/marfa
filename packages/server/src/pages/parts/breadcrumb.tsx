import { localHref } from "../href.js";
import { Icon } from "../icons.js";
import { PAGE_SIZE } from "../navigation.js";
import type { PageRegistry, RegistryItem } from "../registry.js";

export interface Crumb {
  label: string;
  /** Every crumb but the last is a link. */
  href?: string;
}

export interface BreadcrumbProps {
  /** Home: the instance's name, and where Home is. */
  home: { label: string; href: string };
  /** The trail under Home: the page first, then each item deeper. The last is where you are. */
  trail: readonly Crumb[];
  registry: PageRegistry;
  /** The registry id of `trail[0]`, which the picker marks as the current page. */
  pageId?: string;
  /** What is inside pages, for the picker's side panels, by page id. */
  items?: Readonly<Record<string, readonly RegistryItem[]>>;
  /** The address of the item you are in, which its panel marks. */
  currentItemHref?: string;
}

const MENU_ID = "page-picker";
const panelId = (pageId: string): string => `${MENU_ID}-${pageId}`;

function PickerPanel(props: {
  pageId: string;
  title: string;
  items: readonly RegistryItem[];
  currentItemHref?: string;
}) {
  const filterable = props.items.length > PAGE_SIZE;
  return (
    <div
      class="menu fly"
      role="menu"
      id={panelId(props.pageId)}
      aria-label={props.title}
      data-picker-panel
      hidden
    >
      {filterable && (
        <input
          class="menu-search"
          type="search"
          placeholder="Search"
          aria-label={`Search ${props.title}`}
          autocomplete="off"
          data-picker-filter
        />
      )}
      <div class="menu-col">
        {props.items.map((item) => (
          <a
            class="menu-item"
            role="menuitem"
            href={localHref(item.href)}
            aria-current={
              item.href === props.currentItemHref ? "page" : undefined
            }
          >
            <span class="grow">{item.title}</span>
            {item.href === props.currentItemHref && (
              <Icon name="check" size={14} />
            )}
          </a>
        ))}
        {filterable && (
          <div class="menu-none" data-picker-none hidden>
            Nothing matches
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The bar across the top of a console page: Home, then the trail to where you
 * are. On the last crumb sits a button that opens the picker, a menu of every
 * built page in the registry grouped as Home groups them. One level down, a
 * page that has items shows them in a panel beside it.
 *
 * The button and the menus start hidden and a script shows them, so a browser
 * without script sees the trail and no control that does nothing.
 */
export function Breadcrumb(props: BreadcrumbProps) {
  const groups = props.registry.groups();
  const withMenu = props.trail.length > 0 && groups.length > 0;
  const deep = props.trail.length > 1;
  const lastIndex = props.trail.length - 1;

  return (
    <nav class="crumbs" aria-label="Breadcrumb">
      <ol class="crumb-list">
        <li>
          {props.trail.length > 0 ? (
            <a href={localHref(props.home.href)}>{props.home.label}</a>
          ) : (
            <span class="here" aria-current="page">
              {props.home.label}
            </span>
          )}
          {props.trail.length > 0 && <Icon name="chevron" />}
        </li>
        {props.trail.map((crumb, index) => {
          const last = index === lastIndex;
          const label = last ? (
            <span class="here" aria-current="page">
              {crumb.label}
            </span>
          ) : (
            <a
              href={
                crumb.href === undefined ? undefined : localHref(crumb.href)
              }
            >
              {crumb.label}
            </a>
          );
          return (
            <li class={index === 0 && withMenu ? "crumb-has-menu" : undefined}>
              <span class="crumb-pick">
                {label}
                {last && withMenu && (
                  <button
                    type="button"
                    class="crumb-btn"
                    aria-haspopup="menu"
                    aria-expanded="false"
                    aria-controls={MENU_ID}
                    aria-label="Go to another page"
                    data-picker-button
                    hidden
                  >
                    <Icon name="down" size={14} />
                  </button>
                )}
              </span>
              {!last && <Icon name="chevron" />}
              {index === 0 && withMenu && (
                <>
                  <div
                    class="menu"
                    role="menu"
                    id={MENU_ID}
                    aria-label="Pages"
                    hidden
                  >
                    <div class="menu-col" data-picker-list>
                      {groups.map((group) => (
                        <div class="menu-group">
                          <div class="menu-label">{group.title}</div>
                          {group.pages.map((page) => {
                            const hasPanel =
                              deep &&
                              page.hasItems &&
                              (props.items?.[page.id]?.length ?? 0) > 0;
                            return (
                              <a
                                class="menu-item"
                                role="menuitem"
                                href={page.href}
                                aria-current={
                                  page.id === props.pageId ? "page" : undefined
                                }
                                aria-haspopup={hasPanel ? "menu" : undefined}
                                data-panel={
                                  hasPanel ? panelId(page.id) : undefined
                                }
                              >
                                <span class="grow">{page.title}</span>
                                {hasPanel ? (
                                  <Icon name="chevron" size={14} />
                                ) : (
                                  page.id === props.pageId && (
                                    <Icon name="check" size={14} />
                                  )
                                )}
                              </a>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                  {deep &&
                    groups.flatMap((group) =>
                      group.pages.flatMap((page) => {
                        const items = props.items?.[page.id];
                        if (!page.hasItems || !items || items.length === 0)
                          return [];
                        return [
                          <PickerPanel
                            pageId={page.id}
                            title={page.title}
                            items={items}
                            currentItemHref={
                              page.id === props.pageId
                                ? props.currentItemHref
                                : undefined
                            }
                          />,
                        ];
                      }),
                    )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
