/** The one script every page loads. Each module finds its own markup and does nothing without it. */
import { initCommandSearch } from "./command-search.js";
import { initCopy } from "./copy.js";
import { initDialogs } from "./dialog.js";
import { initForms } from "./form.js";
import { initPasskeySignIn } from "./passkey-sign-in.js";
import { initPasswordFields } from "./password.js";
import { initPicker } from "./picker.js";

function start(): void {
  initDialogs();
  initPicker();
  initCommandSearch();
  initForms();
  initPasswordFields();
  initCopy();
  initPasskeySignIn();
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start);
else start();
