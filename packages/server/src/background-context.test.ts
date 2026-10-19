import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { runInBackground } from "./background-context.js";
import {
  validateRequestAuthority,
  withRequestAuthority,
} from "./auth/request-authority.js";
import {
  TransactionControl,
  transactionControl,
} from "./storage/sqlite/transaction-control.js";

it("starts asynchronous work without caller authority or transaction state and restores the caller", async () => {
  const request = new AsyncLocalStorage<string>();
  const control = new TransactionControl();
  control.invalidate(new Error("closed writer"), "ended", "committed");
  const revoked = () => Promise.reject(new Error("revoked credential"));
  await request.run("request", () =>
    transactionControl.run(control, () =>
      withRequestAuthority(revoked, async () => {
        await expect(validateRequestAuthority()).rejects.toThrow(
          "revoked credential",
        );
        expect(() => transactionControl.getStore()?.assertUsable()).toThrow(
          "closed writer",
        );
        await runInBackground(async () => {
          await setTimeout(0);
          await validateRequestAuthority();
          expect(transactionControl.getStore()).toBeUndefined();
          expect(request.getStore()).toBeUndefined();
        });
        expect(request.getStore()).toBe("request");
        expect(transactionControl.getStore()).toBe(control);
        await expect(validateRequestAuthority()).rejects.toThrow(
          "revoked credential",
        );
      }),
    ),
  );
});
