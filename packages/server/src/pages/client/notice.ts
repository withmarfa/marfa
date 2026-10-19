/**
 * The notices a page renders hidden and the script shows. The server writes
 * each into the markup with a `data-notice` name, so the words and the
 * markup stay in one place and the script only chooses which to show.
 */
export function showNotice(
  root: ParentNode,
  slot: string,
  message?: string,
): HTMLElement | null {
  const wrap = root.querySelector<HTMLElement>(`[data-notice="${slot}"]`);
  if (!wrap) return null;
  if (message !== undefined) {
    const text = wrap.querySelector<HTMLElement>("[data-notice-text]");
    if (text) text.textContent = message;
  }
  wrap.hidden = false;
  return wrap;
}

export function hideNotices(root: ParentNode): void {
  for (const wrap of root.querySelectorAll<HTMLElement>("[data-notice]"))
    wrap.hidden = true;
}
