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

/**
 * Hide the notices under `root`: all of them, or only those named in `slots`,
 * so that one the server drew for the page stays.
 */
export function hideNotices(root: ParentNode, slots?: readonly string[]): void {
  for (const wrap of root.querySelectorAll<HTMLElement>("[data-notice]"))
    if (slots === undefined || slots.includes(wrap.dataset.notice ?? ""))
      wrap.hidden = true;
}
