import type { Page } from "playwright-core";

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Where a page header's parts are, in CSS pixels from the top left of the
 * viewport. `action` is the selector of the header's trailing control.
 */
export function headerGeometry(
  page: Page,
  action: string,
): Promise<{ title: Box; lede: Box; action: Box; head: Box }> {
  return page.evaluate((actionSelector) => {
    const box = (el: BrowserElement | null | undefined): Box => {
      if (!el) throw new Error("missing header part");
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const head = document.querySelector(".head");
    return {
      title: box(head?.querySelector("h1")),
      lede: box(head?.querySelector(".lede")),
      action: box(head?.querySelector(actionSelector)),
      head: box(head),
    };
  }, action);
}
