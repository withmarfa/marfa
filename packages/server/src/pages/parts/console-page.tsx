/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { PAGE_REGISTRY } from "../registry.js";
import type { PageRegistry, RegistryItem } from "../registry.js";
import { Breadcrumb } from "./breadcrumb.js";
import type { Crumb } from "./breadcrumb.js";
import { CommandSearch } from "./command-search.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { ConsoleColumn } from "./layout.js";
import { PageShell } from "./shell.js";

/** Where Home is. */
export const HOME_HREF = "/";

export interface ConsolePageProps {
  /** The document title: what a tab and a history entry show. */
  title: string;
  /** The nonce this response's content security policy names. */
  nonce: string;
  /** Home's crumb: what the person has named this Marfa. */
  instanceName: string;
  /** The trail under Home: the page first, then each item deeper. Empty on Home. */
  trail?: readonly Crumb[];
  /** The registry id of `trail[0]`, which the picker marks as the current page. */
  pageId?: string;
  /** What is inside pages, for the picker's side panels, by page id. */
  items?: Readonly<Record<string, readonly RegistryItem[]>>;
  /** The address of the item you are in, which its panel marks. */
  currentItemHref?: string;
  /** The pages the picker and the search offer. Defaults to the console's own. */
  registry?: PageRegistry;
  children?: Child;
}

/**
 * Everything a console page has in common: the document, the breadcrumb with
 * its picker, the search that Command-K opens, the one quiet column and the
 * dialog that asks a person to confirm it's them. A console page renders its
 * header and sections as children and builds none of the rest itself.
 */
export function ConsolePage(props: ConsolePageProps) {
  const registry = props.registry ?? PAGE_REGISTRY;
  return (
    <PageShell title={props.title} nonce={props.nonce}>
      <Breadcrumb
        home={{ label: props.instanceName, href: HOME_HREF }}
        trail={props.trail ?? []}
        registry={registry}
        pageId={props.pageId}
        items={props.items}
        currentItemHref={props.currentItemHref}
      />
      <CommandSearch registry={registry} home={{ href: HOME_HREF }} />
      <ConsoleColumn>{props.children}</ConsoleColumn>
      <ConfirmDialog />
    </PageShell>
  );
}
