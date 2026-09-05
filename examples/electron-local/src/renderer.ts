import { refusalNameOf } from "@withmarfa/sdk/electron/renderer";
import type { MarfaLocalBridge } from "@withmarfa/sdk/electron/renderer";

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
        typeof note.properties.body === "string"
          ? note.properties.body
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
  const text = input.value.trim();
  if (text === "") return;
  input.value = "";
  void marfa
    // `body` because `core.note` requires it, and the engine validates
    // against the type graph before the write is queued — so a note
    // carrying only a title is refused here rather than dead-lettering
    // later. The field a sample writes should be the one the type asks
    // for.
    .createItem({ type: "core.note", properties: { body: text } })
    .then(render)
    .catch((error: unknown) => {
      // `error.name` is not the thing to read: `contextBridge` rebuilds the
      // rejection in this realm and a name assigned on an instance does not
      // make the trip. The class travels in the message, and `refusalNameOf`
      // is what reads it back — which is how an application decides between
      // "this window cannot write" and "that item is gone".
      status.textContent =
        refusalNameOf(error) === "ReadOnlyStoreError"
          ? "Another window holds this store, so nothing typed here can be saved."
          : `Refused: ${error instanceof Error ? error.message : String(error)}`;
    });
});

marfa.on((event) => {
  const row = document.createElement("li");
  row.textContent = JSON.stringify(event);
  events.prepend(row);
  while (events.childElementCount > 8) events.lastElementChild?.remove();
});

void render();
