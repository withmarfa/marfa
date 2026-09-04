import type { MarfaLocalBridge } from "@withmarfa/sdk/electron/preload";

/**
 * The page.
 *
 * It has no Node, no filesystem and no store. `window.marfaLocal` is a set of
 * proxies `contextBridge` put there, and the only reason it can write
 * anything at all is that the main process published a closed set of methods
 * behind them. Everything here is an ordinary browser script.
 */

declare global {
  interface Window {
    marfaLocal: MarfaLocalBridge;
  }
}

const marfa = window.marfaLocal;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the page has no #${id}`);
  return found;
}

const form = element("compose");
const input = element("title") as HTMLInputElement;
const list = element("notes");
const status = element("status");
const events = element("events");

/** What is in the store, as this client sees it: server state plus its own
 *  unsent writes. */
async function render(): Promise<void> {
  const notes = await marfa.listItems({ type: "core.note" });
  list.replaceChildren(
    ...notes.map((note) => {
      const row = document.createElement("li");
      const title =
        typeof note.properties.title === "string"
          ? note.properties.title
          : "(untitled)";
      // `version: 0` is the engine's mark for a row the server has not seen.
      row.textContent = note.version === 0 ? `${title} — not sent yet` : title;
      return row;
    }),
  );

  const now = await marfa.status();
  status.textContent =
    `${String(notes.length)} note(s), ${String(now.pending)} waiting to send. ` +
    `Connection ${now.connection}. ` +
    (now.writer
      ? "This window can write."
      : "Read-only: another window holds the store.");
}

form.addEventListener("submit", (submit) => {
  submit.preventDefault();
  const title = input.value.trim();
  if (title === "") return;
  input.value = "";
  void marfa
    .createItem({ type: "core.note", properties: { title } })
    .then(render)
    .catch((error: unknown) => {
      // A refusal arrives with its class name intact, so a real application
      // would branch on it. Here it goes on screen.
      status.textContent = `refused: ${String(error)}`;
    });
});

marfa.on((event) => {
  const row = document.createElement("li");
  row.textContent = JSON.stringify(event);
  events.prepend(row);
  while (events.childElementCount > 8) events.lastElementChild?.remove();
});

void render();
