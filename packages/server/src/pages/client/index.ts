/** The one script every page loads. Each module finds its own markup and does nothing without it. */
import { initAccess } from "./access.js";
import { initConfirm } from "./confirm.js";
import { initCommandSearch } from "./command-search.js";
import { initCopy } from "./copy.js";
import { initDeviceCode } from "./device-code.js";
import { initDialogs } from "./dialog.js";
import { initForms } from "./form.js";
import { initPasskey } from "./passkey.js";
import { initPasskeySignIn } from "./passkey-sign-in.js";
import { initPasswordFields } from "./password.js";
import { initPicker } from "./picker.js";
import { initSetup } from "./setup.js";

function start(): void {
  initDialogs();
  initPicker();
  initCommandSearch();
  initForms();
  initPasswordFields();
  initCopy();
  initPasskey();
  initSetup();
  initPasskeySignIn();
  initAccess();
  initDeviceCode();
  initConfirm();
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start);
else start();
