import type { WebhookDelivery } from "@withmarfa/shared";
export const deliveryStatus = (status: WebhookDelivery["status"]): string =>
  ({
    dead_letter: "Failed",
    success: "Delivered",
    pending: "Pending",
    canceled: "Canceled",
  })[status];
export function deliveryOutcome(delivery: WebhookDelivery): string {
  const code =
    delivery.status_code === null
      ? null
      : `HTTP ${String(delivery.status_code)}`;
  const error =
    delivery.error && delivery.error !== code ? `. ${delivery.error}` : "";
  return `${String(delivery.attempt)} ${delivery.attempt === 1 ? "attempt" : "attempts"}${code === null ? "" : `, ${code}`}${error}`;
}
