/** The one script every page loads. Each module finds its own markup and does nothing without it. */
import { initAppAccess } from "./app-access.js";
import { initAccess } from "./access.js";
import { initAccount } from "./account.js";
import { initConfirm } from "./confirm.js";
import { initConnectors } from "./connectors.js";
import { initCommandSearch } from "./command-search.js";
import { initCopy } from "./copy.js";
import { initDeviceCode } from "./device-code.js";
import { initDialogs } from "./dialog.js";
import { initExport } from "./export.js";
import { initForms } from "./form.js";
import { initGeneral } from "./general.js";
import { initHealth } from "./health.js";
import { localizeDates } from "./local-date.js";
import { initItems } from "./items.js";
import { initKeys } from "./keys.js";
import { initPasskey } from "./passkey.js";
import { initPasskeySignIn } from "./passkey-sign-in.js";
import { initPasswordFields } from "./password.js";
import { initPicker } from "./picker.js";
import { initSetup } from "./setup.js";
import { initSignIns } from "./sign-ins.js";
import { initSignOut } from "./sign-out.js";

function start(): void {
  initDialogs();
  localizeDates();
  initPicker();
  initCommandSearch();
  initForms();
  initPasswordFields();
  initCopy();
  initPasskey();
  initSetup();
  initPasskeySignIn();
  initAccess();
  initAccount();
  initDeviceCode();
  initConfirm();
  initSignOut();
  initKeys();
  initItems();
  initAppAccess();
  initGeneral();
  initHealth();
  initSignIns();
  initConnectors();
  initExport();
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start);
else start();
