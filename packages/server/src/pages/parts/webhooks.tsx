/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { deliveryOutcome, deliveryStatus } from "../webhook-delivery.js";
import type { WebhookHistory } from "../webhook-history.js";
import {
  Button,
  EmptyState,
  LocalDate,
  Notice,
  Row,
  RowGroup,
  Section,
} from "./index.js";
export function Webhooks({ hooks }: { hooks: WebhookHistory[] | null }) {
  return (
    <Section
      id="webhooks"
      title="Webhooks"
      description="Where it sends changes as they happen."
    >
      {hooks === null ? (
        <Notice tone="error">
          Webhooks could not be loaded. Reload the page to try again.
        </Notice>
      ) : hooks.length === 0 ? (
        <RowGroup>
          <EmptyState
            title="No webhooks"
            description="Webhooks it sets up show here."
          />
        </RowGroup>
      ) : (
        hooks.map((hook) => (
          <div
            data-webhook={hook.id}
            data-active={String(hook.active)}
            class="stack-16"
          >
            <RowGroup>
              <Row
                title={hook.url}
                description={`Sends ${hook.events.join(", ")}.`}
                value={hook.active ? "Enabled" : "Turned off"}
              />
            </RowGroup>
            <details>
              <summary>Delivery history</summary>
              <div data-webhook-notice role="status"></div>
              {hook.history === null ? (
                <Notice tone="error">
                  Delivery history could not be loaded. Reload the page to try
                  again.
                </Notice>
              ) : (
                <>
                  <div data-webhook-deliveries>
                    <RowGroup>
                      {hook.history.data.length === 0 ? (
                        <EmptyState
                          title="No deliveries"
                          description="Deliveries this webhook sends show here."
                        />
                      ) : (
                        hook.history.data.map((delivery) => (
                          <div data-delivery-row={delivery.id}>
                            <Row
                              title={delivery.event_type}
                              description={
                                <>
                                  <LocalDate
                                    at={new Date(delivery.created_at)}
                                  />
                                  {`. ${deliveryOutcome(delivery)}`}
                                </>
                              }
                              buttons={
                                <>
                                  <span data-delivery-status>
                                    {deliveryStatus(delivery.status)}
                                  </span>
                                  {delivery.status === "dead_letter" &&
                                    hook.active && (
                                      <Button
                                        hook="webhook-retry"
                                        data={{ delivery: delivery.id }}
                                        loadingLabel="Queuing..."
                                      >
                                        Retry
                                      </Button>
                                    )}
                                </>
                              }
                            />
                            <div data-webhook-notice role="status"></div>
                          </div>
                        ))
                      )}
                    </RowGroup>
                  </div>
                  {hook.history.next_cursor !== null && (
                    <Button
                      hook="webhook-more"
                      data={{ cursor: hook.history.next_cursor }}
                      loadingLabel="Loading..."
                    >
                      More deliveries
                    </Button>
                  )}
                </>
              )}
            </details>
          </div>
        ))
      )}
    </Section>
  );
}
