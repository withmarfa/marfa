import { deliveryOutcome, deliveryStatus } from "../webhook-delivery.js";
import { localizeDates } from "./local-date.js";
import type { WebhookDelivery, PaginatedResult } from "@withmarfa/shared";
import { sendConfirmed } from "./confirm.js";
import { busy } from "./page-state.js";

function notice(root: HTMLElement, text: string): void {
  const node = root.querySelector<HTMLElement>("[data-webhook-notice]");
  if (node) node.textContent = text;
}
function appendDelivery(root: HTMLElement, delivery: WebhookDelivery): void {
  const container = root.querySelector("[data-webhook-deliveries] .group");
  const target = container ?? root.querySelector("[data-webhook-deliveries]");
  if (!target) return;
  const wrapper = document.createElement("div");
  wrapper.dataset.deliveryRow = delivery.id;
  const row = document.createElement("div");
  row.className = "row has-d";
  const copy = document.createElement("div");
  copy.className = "grow";
  const title = document.createElement("div");
  title.className = "rt";
  title.textContent = delivery.event_type;
  const description = document.createElement("div");
  description.className = "rd";
  const date = document.createElement("time");
  date.dateTime = delivery.created_at;
  date.dataset.localDate = "";
  description.append(date, `. ${deliveryOutcome(delivery)}`);
  localizeDates(description);
  copy.append(title, description);
  const status = document.createElement("span");
  status.dataset.deliveryStatus = "";
  status.textContent = deliveryStatus(delivery.status);
  const ends = document.createElement("span");
  ends.className = "ends";
  ends.append(status);
  row.append(copy, ends);
  if (delivery.status === "dead_letter" && root.dataset.active === "true") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn quiet";
    button.dataset.hook = "webhook-retry";
    button.dataset.delivery = delivery.id;
    button.dataset.loadingLabel = "Queuing...";
    button.textContent = "Retry";
    ends.append(button);
  }
  const feedback = document.createElement("div");
  feedback.dataset.webhookNotice = "";
  feedback.setAttribute("role", "status");
  wrapper.append(row, feedback);
  target.append(wrapper);
}
export function initWebhooks(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-webhook]")) {
    const base = `/webhooks/${encodeURIComponent(root.dataset.webhook ?? "")}/deliveries`;
    root.addEventListener("click", (event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>("button[data-hook]")
          : null;
      if (!button || button.disabled) return;
      const retry = button.dataset.hook === "webhook-retry";
      if (!retry && button.dataset.hook !== "webhook-more") return;
      const noticeRoot = retry
        ? (button.closest<HTMLElement>("[data-delivery-row]") ?? root)
        : root;
      const delivery = button.dataset.delivery;
      const path = retry
        ? `${base}/${encodeURIComponent(delivery ?? "")}/redeliver`
        : `${base}?limit=10&cursor=${encodeURIComponent(button.dataset.cursor ?? "")}`;
      button.disabled = true;
      busy(button, true);
      void (async () => {
        try {
          const send = () =>
            fetch(path, {
              method: retry ? "POST" : "GET",
              headers: { accept: "application/json" },
            });
          const response = retry
            ? await sendConfirmed(
                send,
                "Retrying a webhook delivery needs a recent sign-in.",
                button,
              )
            : await send();
          if (response === null) return;
          if (!response.ok) {
            notice(
              noticeRoot,
              retry
                ? response.status === 409
                  ? "This delivery cannot be retried. It may no longer be retained, or the webhook or its access has changed."
                  : "The retry could not be confirmed. Reload the history before trying again."
                : "More deliveries could not be loaded. Try again.",
            );
            return;
          }
          if (retry) {
            const row = button.closest<HTMLElement>("[data-delivery-row]");
            const state = row?.querySelector<HTMLElement>(
              "[data-delivery-status]",
            );
            if (state) state.textContent = "Pending";
            button.hidden = true;
            notice(
              noticeRoot,
              "Retry queued. Reload the page later to see the result.",
            );
          } else {
            const page =
              (await response.json()) as PaginatedResult<WebhookDelivery>;
            for (const row of page.data) appendDelivery(root, row);
            if (page.next_cursor === null) button.hidden = true;
            else button.dataset.cursor = page.next_cursor;
            notice(noticeRoot, "");
          }
        } catch {
          notice(
            noticeRoot,
            retry
              ? "The retry could not be confirmed. Reload the history before trying again."
              : "More deliveries could not be loaded. Try again.",
          );
        } finally {
          busy(button, false);
          button.disabled = false;
        }
      })();
    });
  }
}
