/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { localHref } from "../href.js";
import type { PageRegistry } from "../registry.js";

export interface CommandSearchProps {
  registry: PageRegistry;
  /** Home, which the search offers like a page. */
  home: { href: string };
}

interface Option {
  id: string;
  title: string;
  href: string;
  meta: string;
  haystack: string;
}

function Options(props: { options: readonly Option[] }) {
  return (
    <>
      {props.options.map((option) => (
        <a
          class="pal-row"
          role="option"
          id={option.id}
          href={option.href}
          tabindex={-1}
          aria-selected="false"
          data-title={option.title}
          data-haystack={option.haystack}
          hidden
        >
          <span class="grow" data-title-text>
            {option.title}
          </span>
          {option.meta !== "" && <span class="meta">{option.meta}</span>}
        </a>
      ))}
    </>
  );
}

/**
 * The search over pages and settings, a modal dialog a script opens with
 * Command-K (Control-K off Apple platforms) from any page. The pages are
 * written here and the script only filters them, so nothing is searched on the
 * server and nothing links to a page that is not built. The few settings that
 * other pages register are written here too, but the settings page's own are
 * too many to send with every page: when that page is built, the script reads
 * them from its `.json` answer the first time the dialog opens.
 */
export function CommandSearch(props: CommandSearchProps) {
  const groups = props.registry.groups();
  const home: Option = {
    id: "cs-page-home",
    title: "Home",
    href: localHref(props.home.href),
    meta: "",
    haystack: "Home Everything, by section",
  };
  const pages: Option[] = [
    home,
    ...groups.flatMap((group) =>
      group.pages.map((page) => ({
        id: `cs-page-${page.id}`,
        title: page.title,
        href: page.href,
        meta: group.title,
        haystack: `${page.title} ${page.description} ${group.title}`,
      })),
    ),
  ];
  const settingsPage = props.registry.page("settings");
  const settings: Option[] = groups.flatMap((group) =>
    group.pages
      .filter((page) => page !== settingsPage)
      .flatMap((page) =>
        page.settings.map((setting) => ({
          id: `cs-setting-${page.id}-${setting.id}`,
          title: setting.title,
          href: setting.href,
          meta: page.title,
          haystack: `${setting.title} ${setting.description ?? ""} ${setting.id} ${setting.group}`,
        })),
      ),
  );
  const suggested: Option[] = [
    { ...home, id: "cs-suggested-home" },
    ...props.registry.suggested().map((page) => ({
      id: `cs-suggested-${page.id}`,
      title: page.title,
      href: page.href,
      meta: page.group,
      haystack: "",
    })),
  ];

  return (
    <dialog
      class="palette"
      id="command-search"
      aria-label="Go to a page or setting"
      data-command-search
      data-settings-source={
        settingsPage === undefined ? undefined : `${settingsPage.href}.json`
      }
    >
      <div class="palette-card">
        <input
          class="pal-in"
          type="text"
          placeholder="Go to a page or setting"
          aria-label="Go to a page or setting"
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="cs-list"
          data-search-input
        />
        <div class="pal-list" id="cs-list" role="listbox" aria-label="Results">
          <div
            role="group"
            aria-labelledby="cs-label-suggested"
            data-search-group="suggested"
          >
            <div class="pal-label" id="cs-label-suggested">
              Suggested
            </div>
            <Options options={suggested} />
          </div>
          <div
            role="group"
            aria-labelledby="cs-label-pages"
            data-search-group="pages"
            hidden
          >
            <div class="pal-label" id="cs-label-pages">
              Pages
            </div>
            <Options options={pages} />
          </div>
          <div
            role="group"
            aria-labelledby="cs-label-settings"
            data-search-group="settings"
            hidden
          >
            <div class="pal-label" id="cs-label-settings">
              Settings
            </div>
            <Options options={settings} />
          </div>
          <div class="pal-none" data-search-status hidden></div>
          <div class="pal-none" data-search-none hidden>
            Nothing matches.
          </div>
        </div>
      </div>
    </dialog>
  );
}
