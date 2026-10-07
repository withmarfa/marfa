# Inbound webhooks

A webhook endpoint is an address a sender such as GitHub posts to without a credential: the address is the credential. The server stores each request as it came and answers at once, and holds no sender's secret. The connector that owns the endpoint reads its deliveries with its own key, checks that each came from its sender, and marks it handled.

The webhooks the instance sends are outbound ones, `events.md`'s. The error envelope and the codes are `errors.md`'s, and the settings named here are `instance.md`'s.

## Endpoints

An endpoint belongs to one registration, which holds at most ten live endpoints. A retired endpoint stays listed.

### `inbound-webhooks/endpoint-created`

When the connector's own key or the operator key sends `POST /connectors/{id}/endpoints`, the server MUST answer `201` with the endpoint's `id`, `connector_id`, `label`, `duplicate_header`, `path`, `created_at` and `retired_at`.

**Tests:** `compliance/inbound-webhooks.test.ts › makes an endpoint for the connector's own key and the operator, answering its address once`.

### `inbound-webhooks/endpoint-live`

When the server answers a new endpoint, the server MUST give its `retired_at` as `null`.

**Tests:** `compliance/inbound-webhooks.test.ts › makes an endpoint for the connector's own key and the operator, answering its address once`.

### `inbound-webhooks/endpoint-path-form`

When the server answers a new endpoint, the server MUST give its `path` as `/inbound/` and 43 characters of base64url.

**Tests:** `compliance/inbound-webhooks.test.ts › makes an endpoint for the connector's own key and the operator, answering its address once`.

### `inbound-webhooks/endpoint-path-redacted`

When the server lists endpoints, the server MUST give each `path` as `/inbound/****` and its last four characters.

**Reason:** the address is the credential, so only the answer that creates it shows it in full.

**Tests:** `compliance/inbound-webhooks.test.ts › makes an endpoint for the connector's own key and the operator, answering its address once`.

### `inbound-webhooks/endpoint-header-lowercased`

When `POST /connectors/{id}/endpoints` names a `duplicate_header`, the server MUST answer it lowercased.

**Tests:** `compliance/inbound-webhooks.test.ts › makes an endpoint for the connector's own key and the operator, answering its address once`.

### `inbound-webhooks/endpoint-label-bounds`

If `POST /connectors/{id}/endpoints` names a `label` outside 1 to 200 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses another key, an unknown registration and a header that is no header name`.

### `inbound-webhooks/endpoint-header-name`

If `POST /connectors/{id}/endpoints` names a `duplicate_header` that is not an HTTP header name of 1 to 100 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses another key, an unknown registration and a header that is no header name`.

### `inbound-webhooks/endpoint-other-refused`

If a key that is neither the connector's own nor the operator key sends `POST /connectors/{id}/endpoints`, `GET /connectors/{id}/endpoints` or `DELETE /connectors/{id}/endpoints/{endpoint_id}`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses another key, an unknown registration and a header that is no header name`.

### `inbound-webhooks/endpoint-unknown-registration`

If `POST /connectors/{id}/endpoints`, `GET /connectors/{id}/endpoints` or `DELETE /connectors/{id}/endpoints/{endpoint_id}` names an id no registration carries, then the server MUST answer `404 connector_not_found`.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses another key, an unknown registration and a header that is no header name`, `compliance/connector-check-order.test.ts › answers a registration that is not there 404 before the key's 403, on every door the key reaches`.

### `inbound-webhooks/endpoint-list`

When the connector's own key or the operator key sends `GET /connectors/{id}/endpoints`, the server MUST list every endpoint of the registration, the retired ones included.

**Tests:** `compliance/inbound-webhooks.test.ts › makes an endpoint for the connector's own key and the operator, answering its address once`, `› retires an endpoint, after which its address is not served`.

### `inbound-webhooks/endpoint-list-newest-first`

When the server lists endpoints, the server MUST list the newest endpoint first.

**Tests:** `compliance/inbound-webhooks.test.ts › makes an endpoint for the connector's own key and the operator, answering its address once`.

### `inbound-webhooks/endpoint-list-whole`

When the connector's own key or the operator key sends `GET /connectors/{id}/endpoints`, the server MUST answer the whole list with `next_cursor` `null`.

**Reason:** the operation takes no `limit` and no `cursor`.

**Tests:** `compliance/envelope.test.ts › answers a null cursor from every door that takes none`.

### `inbound-webhooks/endpoint-limit`

If a registration holds ten live endpoints and the server would otherwise take a `POST /connectors/{id}/endpoints` for another, then the server MUST answer `409 conflict`.

**Tests:** `compliance/inbound-webhooks.test.ts › holds a registration to ten live endpoints, and a retired one frees a place`.

### `inbound-webhooks/endpoint-limit-frees`

When an endpoint of a registration that holds ten live endpoints is retired, the server MUST take `POST /connectors/{id}/endpoints` for another.

**Tests:** `compliance/inbound-webhooks.test.ts › holds a registration to ten live endpoints, and a retired one frees a place`.

### `inbound-webhooks/endpoint-limit-concurrent`

When twenty requests to `POST /connectors/{id}/endpoints` arrive at once for a registration that holds none, the server MUST answer ten `201` and ten `409 conflict`.

**Tests:** `compliance/connector-races.test.ts › makes ten live endpoints and refuses the rest when twenty are asked for at once`.

### `inbound-webhooks/endpoint-retire`

When the connector's own key or the operator key sends `DELETE /connectors/{id}/endpoints/{endpoint_id}` for an endpoint the registration holds, the server MUST answer `200` with the endpoint and its `retired_at` set.

**Tests:** `compliance/inbound-webhooks.test.ts › retires an endpoint, after which its address is not served`.

### `inbound-webhooks/endpoint-retire-listed`

When the server retires an endpoint, the server MUST keep it in the list of the registration's endpoints.

**Tests:** `compliance/inbound-webhooks.test.ts › retires an endpoint, after which its address is not served`.

### `inbound-webhooks/endpoint-retire-again`

When `DELETE /connectors/{id}/endpoints/{endpoint_id}` names an endpoint that is retired already, the server MUST answer `200` with the `retired_at` it already had.

**Tests:** `compliance/inbound-webhooks.test.ts › retires an endpoint, after which its address is not served`.

### `inbound-webhooks/endpoint-retire-unknown`

If `DELETE /connectors/{id}/endpoints/{endpoint_id}` names an endpoint the registration does not hold, another registration's endpoint included, then the server MUST answer `404 endpoint_not_found`.

**Tests:** `compliance/inbound-webhooks.test.ts › retires an endpoint, after which its address is not served`, `compliance/connector-codes.test.ts › answers another connector's delivery, endpoint and registration with the code of each, and marks and retires nothing`.

### `inbound-webhooks/endpoint-retire-other-keeps`

If the server refuses `DELETE /connectors/{id}/endpoints/{endpoint_id}` for an endpoint of another registration, then the server MUST NOT retire that endpoint.

**Tests:** `compliance/connector-codes.test.ts › answers another connector's delivery, endpoint and registration with the code of each, and marks and retires nothing`.

### `inbound-webhooks/endpoint-retire-keeps-deliveries`

When the server retires an endpoint, the server MUST keep the deliveries it stored readable to the registration's key.

**Tests:** `compliance/inbound-webhooks.test.ts › retires an endpoint, after which its address is not served`.

### `inbound-webhooks/endpoint-audit-create`

When the server creates an endpoint, the server MUST record an `inbound_endpoint.create` audit entry against the endpoint's id.

**Tests:** `compliance/inbound-webhooks.test.ts › audits a creation and a retirement once each, and neither a receipt nor a handled mark`.

### `inbound-webhooks/endpoint-audit-retire`

When the server retires an endpoint, the server MUST record an `inbound_endpoint.retire` audit entry against the endpoint's id.

**Tests:** `compliance/inbound-webhooks.test.ts › audits a creation and a retirement once each, and neither a receipt nor a handled mark`.

### `inbound-webhooks/endpoint-audit-retire-again`

When `DELETE /connectors/{id}/endpoints/{endpoint_id}` names an endpoint that is retired already, the server MUST NOT record an audit entry for it.

**Tests:** `compliance/inbound-webhooks.test.ts › audits a creation and a retirement once each, and neither a receipt nor a handled mark`.

### `inbound-webhooks/endpoints-go-with-it`

When a registration is removed, the server MUST answer a request to the address of each of its endpoints with `404`.

**Reason:** an address of a removed registration is one no live endpoint holds, as `inbound-webhooks/address-unknown` says, and the deliveries its endpoints stored go with the registration.

**Tests:** `compliance/inbound-webhooks.test.ts › goes with its registration, and its deliveries with it`.

## Receiving a delivery

`POST /inbound/{token}` is the one operation a sender calls, and it takes no credential.

### `inbound-webhooks/receipt-accepted`

When a request posts to the address of a live endpoint, whether or not it carries a credential, the server MUST answer `202` with `id`, the id of the delivery it stored.

**Reason:** the connector that owns the endpoint verifies each delivery, and the server holds no sender's secret, so it stores what came and answers at once.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`, `› stores a signed delivery whose signature verifies over the stored bytes`, `› reads no key on a receipt, never stamping one used, and stores the header like any other`, `› announces nothing on the event stream`.

### `inbound-webhooks/receipt-pending`

When the server stores a delivery, the server MUST give its `handled_at` and its `outcome` as `null`.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`.

### `inbound-webhooks/receipt-method`

When the server stores a delivery, the server MUST give its `method` as `POST`.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`.

### `inbound-webhooks/receipt-query`

When the server stores a delivery, the server MUST store the query string as the sender sent it, without the `?`.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`.

### `inbound-webhooks/receipt-headers`

When the server stores a delivery, the server MUST store every header the request carried, in the order and the case it arrived with, repeats kept.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`.

### `inbound-webhooks/receipt-body`

When the server stores a delivery, the server MUST store the body byte for byte.

**Reason:** a signature a sender made over the body is only checked against the bytes it was made over.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`, `› stores a signed delivery whose signature verifies over the stored bytes`.

### `inbound-webhooks/receipt-size-hash`

When the server stores a delivery, the server MUST give its `size` as the length of the body in bytes and its `sha256` as the SHA-256 hash of the body in hexadecimal.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`.

### `inbound-webhooks/receipt-received-at`

When the server stores a delivery, the server MUST give its `received_at` as the time on its own clock.

**Tests:** `compliance/connector-codes.test.ts › stamps a heartbeat, a run's report and a receipt with its own clock`.

### `inbound-webhooks/receipt-authorization-stored`

When a request to an inbound address carries an `Authorization` header, the server MUST store the header as it stores any other.

**Tests:** `compliance/inbound-webhooks.test.ts › reads no key on a receipt, never stamping one used, and stores the header like any other`.

### `inbound-webhooks/receipt-key-unused`

When a request to an inbound address carries a key in an `Authorization` header, the server MUST NOT set that key's `last_used_at`.

**Reason:** the operation reads no credential, so a key presented there is not used.

**Tests:** `compliance/inbound-webhooks.test.ts › reads no key on a receipt, never stamping one used, and stores the header like any other`.

### `inbound-webhooks/receipt-no-event`

When the server stores a delivery, the server MUST NOT announce it on the event stream.

**Tests:** `compliance/inbound-webhooks.test.ts › announces nothing on the event stream`.

### `inbound-webhooks/receipt-no-audit`

When the server stores a delivery, the server MUST NOT record an audit entry for it.

**Tests:** `compliance/inbound-webhooks.test.ts › audits a creation and a retirement once each, and neither a receipt nor a handled mark`.

## Addresses that answer nothing

### `inbound-webhooks/address-unknown`

If a request posts to an address no live endpoint holds, then the server MUST answer `404 not_found` in the envelope it gives a path it does not serve.

**Reason:** an address that is not live answers as a path that is not there, so a sender learns nothing of which addresses were ever made.

**Tests:** `compliance/inbound-webhooks.test.ts › answers an address no endpoint holds as a path the server does not serve`.

### `inbound-webhooks/address-unknown-stores-nothing`

If a request posts to an address no live endpoint holds, then the server MUST NOT store a delivery.

**Tests:** `compliance/inbound-webhooks.test.ts › answers an address no endpoint holds as a path the server does not serve`, `› retires an endpoint, after which its address is not served`.

### `inbound-webhooks/address-retired`

When a request posts to the address of a retired endpoint, the server MUST answer `404 not_found`.

**Tests:** `compliance/inbound-webhooks.test.ts › retires an endpoint, after which its address is not served`.

### `inbound-webhooks/address-key-revoked`

While the key of an endpoint's registration is revoked, the server MUST answer a request to the endpoint's address with `404 not_found`.

**Tests:** `compliance/inbound-webhooks.test.ts › stops answering once the registration's key is revoked`.

## Size and time

### `inbound-webhooks/body-over-limit`

If a request to an inbound address carries a body larger than the limit, 26214400 bytes unless `MARFA_INBOUND_MAX_BYTES` names another, then the server MUST answer `413 request_too_large`.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses a body over the limit, and stores one at it`, `compliance/inbound-bounds.test.ts › stores a body of exactly MARFA_INBOUND_MAX_BYTES and refuses one byte more`.

### `inbound-webhooks/body-at-limit`

When a request to an inbound address carries a body of exactly the limit, the server MUST store it.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses a body over the limit, and stores one at it`, `compliance/inbound-bounds.test.ts › stores a body of exactly MARFA_INBOUND_MAX_BYTES and refuses one byte more`.

### `inbound-webhooks/body-over-stores-nothing`

If the server refuses a body with `413 request_too_large`, then the server MUST NOT store a delivery for it.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses a body over the limit, and stores one at it`, `compliance/inbound-bounds.test.ts › stores a body of exactly MARFA_INBOUND_MAX_BYTES and refuses one byte more`.

### `inbound-webhooks/body-declared-over`

If a request to an inbound address declares a `Content-Length` over the limit, then the server MUST answer `413 request_too_large` before the body arrives.

**Tests:** `compliance/inbound-bounds.test.ts › refuses a declared length over the limit before it reads the body`, `compliance/inbound-check-order.test.ts › answers a declared length over the limit 413 before the body's 408`.

### `inbound-webhooks/body-chunked-over`

If a body sent without a `Content-Length` passes the limit across its chunks, then the server MUST answer `413 request_too_large`.

**Tests:** `compliance/inbound-bounds.test.ts › stores a body of exactly MARFA_INBOUND_MAX_BYTES and refuses one byte more`.

### `inbound-webhooks/body-timeout`

If a body has not arrived whole within `MARFA_INBOUND_READ_TIMEOUT_MS`, 30000 milliseconds unless named, then the server MUST answer `408 request_timeout`.

**Tests:** `compliance/inbound-webhooks.test.ts › answers request_timeout to a body that does not arrive in time, and stores nothing`, `compliance/inbound-check-order.test.ts › answers a declared length over the limit 413 before the body's 408`.

### `inbound-webhooks/body-timeout-stores-nothing`

If the server answers `408 request_timeout`, then the server MUST NOT store a delivery for it.

**Reason:** a sender that stalls holds none of the instance's bytes for longer than the timeout.

**Tests:** `compliance/inbound-webhooks.test.ts › answers request_timeout to a body that does not arrive in time, and stores nothing`.

## The rate window

Each endpoint has a window of its own, so a busy sender of one endpoint does not slow another. The limiter is on unless `RATE_LIMIT_ENABLED` says otherwise.

### `inbound-webhooks/rate-limit`

While the limiter is on, if an endpoint's address receives more requests in one window than `RATE_LIMIT_INBOUND_REQUESTS`, 600 unless named, then the server MUST answer the request past the count `429 rate_limited`.

**Tests:** `compliance/inbound-webhooks.test.ts › holds each endpoint to its own rate window`, `compliance/inbound-rate-limit.test.ts › counts every request to a live address in its window, whatever answer it got`, `› ends a window after RATE_LIMIT_WINDOW_MS, and tells a refused sender how long is left`.

### `inbound-webhooks/rate-counts-every-request`

While the limiter is on, the server MUST count every request to the address of a live endpoint in that endpoint's window, whatever answer the request gets.

**Tests:** `compliance/inbound-rate-limit.test.ts › counts every request to a live address in its window, whatever answer it got`.

### `inbound-webhooks/rate-unknown-free`

While the limiter is on, the server MUST NOT count a request to an address no live endpoint holds.

**Tests:** `compliance/inbound-rate-limit.test.ts › spends no window on an address nothing holds`.

### `inbound-webhooks/rate-window-length`

While the limiter is on, the server MUST end an endpoint's window after `RATE_LIMIT_WINDOW_MS`, 60000 milliseconds unless named, and take the full count again in the next.

**Tests:** `compliance/inbound-rate-limit.test.ts › ends a window after RATE_LIMIT_WINDOW_MS, and tells a refused sender how long is left`.

### `inbound-webhooks/rate-retry-after`

When the server answers `429 rate_limited` to a request to an inbound address, the server MUST carry a `Retry-After` of the seconds left in the endpoint's window.

**Tests:** `compliance/inbound-rate-limit.test.ts › ends a window after RATE_LIMIT_WINDOW_MS, and tells a refused sender how long is left`, `compliance/inbound-webhooks.test.ts › holds each endpoint to its own rate window`.

### `inbound-webhooks/rate-own-window`

While the limiter is on, the server MUST hold each endpoint to a window of its own, another endpoint of the same registration included.

**Tests:** `compliance/inbound-webhooks.test.ts › holds each endpoint to its own rate window`.

## What a registration may hold

Three things bound what a registration holds: what it has not handled, what it retains whether handled or not, and the bytes of bodies the instance holds while they arrive.

### `inbound-webhooks/backlog-count`

If a receipt would take the unhandled deliveries of a registration, across all its endpoints, live and retired, past `MARFA_INBOUND_BACKLOG_DELIVERIES`, 10000 unless named, then the server MUST answer `503 inbound_unavailable`.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses while the backlog is full, and takes again once it drains`.

### `inbound-webhooks/backlog-count-retired`

When the server counts a registration's unhandled deliveries against `MARFA_INBOUND_BACKLOG_DELIVERIES`, the server MUST count those that a retired endpoint stored.

**Tests:** `compliance/inbound-webhooks.test.ts › counts the unhandled deliveries a retired endpoint stored toward the backlog, until they are handled`.

### `inbound-webhooks/backlog-bytes`

If a receipt would take the bytes of a registration's unhandled bodies past `MARFA_INBOUND_BACKLOG_BYTES`, 1073741824 unless named, then the server MUST answer `503 inbound_unavailable`.

**Reason:** the server adds the receipt's own body to the bytes already held, so a body that would pass the limit is refused before it is stored.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses while the backlog's bytes are full`, `› checks prospective bytes and accepts a zero body at exactly full pending bytes`.

### `inbound-webhooks/backlog-zero-body`

When a registration's unhandled bodies hold exactly `MARFA_INBOUND_BACKLOG_BYTES` bytes and its count has room, the server MUST take a receipt with an empty body.

**Tests:** `compliance/inbound-webhooks.test.ts › checks prospective bytes and accepts a zero body at exactly full pending bytes`.

### `inbound-webhooks/backlog-handled-frees`

When a delivery is marked handled, the server MUST stop counting it toward its registration's backlog of deliveries and bytes.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses while the backlog is full, and takes again once it drains`.

### `inbound-webhooks/backlog-refused-stores-nothing`

If the server answers `503 inbound_unavailable`, then the server MUST NOT store a delivery for the request.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses while the backlog's bytes are full`, `› refuses a body that would pass the bytes the instance holds in flight`.

### `inbound-webhooks/backlog-concurrent-count`

When three receipts complete together at a registration whose backlog has room for two deliveries, the server MUST answer two `202` and one `503 inbound_unavailable`.

**Reason:** the limit holds however the bodies interleave, so no combination of receipts passes it.

**Tests:** `compliance/connector-races.test.ts › takes no more receipts than the backlog holds in deliveries when three complete together`.

### `inbound-webhooks/backlog-concurrent-bytes`

When three receipts of three bytes complete together at a registration whose backlog has room for four bytes, the server MUST answer one `202` and two `503 inbound_unavailable`.

**Tests:** `compliance/connector-races.test.ts › takes no more receipts than the backlog holds in bytes when three complete together`.

### `inbound-webhooks/unavailable-retry-after`

When the server answers `503 inbound_unavailable`, the server MUST carry a `Retry-After` in seconds.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses while the backlog is full, and takes again once it drains`, `compliance/inbound-bounds.test.ts › refuses a body that would pass the bytes in flight summed across bodies, takes one that fills them, and gives back what a body held when it ended or broke off`, `compliance/inbound-webhooks.test.ts › bounds handled zero-body receipts across live and retired endpoints of a registration`.

### `inbound-webhooks/capacity-keeps-deliveries`

If the server refuses a receipt for capacity, then the server MUST NOT remove a delivery it has stored.

**Reason:** only age removes a delivery, as `inbound-webhooks/retention-pending` and `inbound-webhooks/retention-handled` say.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses while the backlog's bytes are full`, `› checks prospective bytes and accepts a zero body at exactly full pending bytes`, `› bounds handled zero-body receipts across live and retired endpoints of a registration`.

### `inbound-webhooks/in-flight-limit`

If a body would take the bytes of all the bodies the instance is receiving past `MARFA_INBOUND_IN_FLIGHT_BYTES`, 104857600 unless named, then the server MUST answer `503 inbound_unavailable`.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses a body that would pass the bytes the instance holds in flight`, `compliance/inbound-bounds.test.ts › refuses a body that would pass the bytes in flight summed across bodies, takes one that fills them, and gives back what a body held when it ended or broke off`.

### `inbound-webhooks/in-flight-summed`

When several bodies are arriving at once, the server MUST count their bytes together against `MARFA_INBOUND_IN_FLIGHT_BYTES`.

**Tests:** `compliance/inbound-bounds.test.ts › refuses a body that would pass the bytes in flight summed across bodies, takes one that fills them, and gives back what a body held when it ended or broke off`.

### `inbound-webhooks/in-flight-returned`

When a body ends, whether it arrived whole, was refused or broke off, the server MUST stop counting its bytes toward the bytes in flight.

**Tests:** `compliance/inbound-bounds.test.ts › refuses a body that would pass the bytes in flight summed across bodies, takes one that fills them, and gives back what a body held when it ended or broke off`, `› refuses a body whose endpoint was retired while it arrived, and stores nothing`, `› refuses a body whose key was revoked while it arrived`.

### `inbound-webhooks/arriving-retired`

If an endpoint is retired while a body is arriving at its address, then the server MUST answer `404 not_found`.

**Tests:** `compliance/inbound-bounds.test.ts › refuses a body whose endpoint was retired while it arrived, and stores nothing`.

### `inbound-webhooks/arriving-retired-stores-nothing`

If an endpoint is retired while a body is arriving at its address, then the server MUST NOT store a delivery for the body.

**Tests:** `compliance/inbound-bounds.test.ts › refuses a body whose endpoint was retired while it arrived, and stores nothing`.

### `inbound-webhooks/arriving-revoked`

If the key of an endpoint's registration is revoked while a body is arriving at its address, then the server MUST answer `404 not_found`.

**Tests:** `compliance/inbound-bounds.test.ts › refuses a body whose key was revoked while it arrived`.

### `inbound-webhooks/retained-count`

If a receipt would take the deliveries a registration retains, handled or unhandled, across its live and retired endpoints, past `MARFA_INBOUND_RETAINED_DELIVERIES`, 10000 unless named, then the server MUST answer `503 inbound_unavailable`.

**Tests:** `compliance/inbound-webhooks.test.ts › bounds handled zero-body receipts across live and retired endpoints of a registration`.

### `inbound-webhooks/retained-bytes`

If a receipt's charge would take the bytes a registration retains past `MARFA_INBOUND_RETAINED_BYTES`, 1073741824 unless named, then the server MUST answer `503 inbound_unavailable`.

**Tests:** `compliance/inbound-bounds.test.ts › takes a second receipt at exactly twice the charge of the first and refuses it one byte under`, `compliance/inbound-webhooks.test.ts › counts query metadata when every retained body has zero bytes`.

### `inbound-webhooks/retained-charge`

When the server charges a receipt against the bytes a registration retains, the server MUST charge the length of its body, plus the UTF-8 length of the compact JSON object of its `id`, `endpoint_id`, `connector_id`, `received_at`, `method`, `query`, `headers`, `size` and `sha256`, `dedupe_key` as the value the delivery carries in its endpoint's duplicate header or `null`, and `handled_at` and `outcome` as `null`, in that order, plus 32.

**Reason:** the 32 bytes are kept for the marks a handled delivery gains, so handling never needs capacity. The charge bounds what is retained, not the size of the database file or the memory the server uses.

**Tests:** `compliance/inbound-bounds.test.ts › takes a second receipt at exactly twice the charge of the first and refuses it one byte under`, `compliance/inbound-webhooks.test.ts › counts query metadata when every retained body has zero bytes`.

### `inbound-webhooks/retained-handling-no-free`

When a delivery is marked handled, the server MUST NOT stop counting it toward the deliveries and bytes its registration retains.

**Tests:** `compliance/inbound-webhooks.test.ts › bounds handled zero-body receipts across live and retired endpoints of a registration`.

### `inbound-webhooks/retained-registrations-apart`

When a registration has reached a retained limit, the server MUST take receipts for another registration.

**Tests:** `compliance/inbound-webhooks.test.ts › bounds handled zero-body receipts across live and retired endpoints of a registration`.

### `inbound-webhooks/retained-limit-holds-without-expiry`

Where both retentions are 0, the server MUST still answer `503 inbound_unavailable` to a receipt that would pass a retained limit.

**Tests:** `compliance/inbound-webhooks.test.ts › bounds handled zero-body receipts across live and retired endpoints of a registration`, `› counts query metadata when every retained body has zero bytes`.

### `inbound-webhooks/retained-charge-hidden`

When the server lists deliveries, the server MUST NOT give a delivery's charge.

**Tests:** `compliance/inbound-webhooks.test.ts › bounds handled zero-body receipts across live and retired endpoints of a registration`.

## Reading deliveries

A delivery is read from the list, its body from an operation of its own, and marked handled in a batch.

### `inbound-webhooks/deliveries-list`

When the connector's own key sends `GET /connectors/{id}/deliveries`, the server MUST list the registration's deliveries, each with its `id`, `endpoint_id`, `received_at`, `method`, `query`, `headers`, `size`, `sha256`, `duplicate_of`, `handled_at` and `outcome` and without its body.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`, `› lists oldest first by cursor, narrowed by state and endpoint`.

### `inbound-webhooks/deliveries-oldest-first`

When the server lists deliveries, the server MUST list the delivery received earliest first.

**Tests:** `compliance/inbound-webhooks.test.ts › lists oldest first by cursor, narrowed by state and endpoint`.

### `inbound-webhooks/deliveries-pending-default`

When `GET /connectors/{id}/deliveries` names no `state`, the server MUST list only the unhandled deliveries.

**Tests:** `compliance/inbound-webhooks.test.ts › lists oldest first by cursor, narrowed by state and endpoint`.

### `inbound-webhooks/deliveries-state-handled`

When `GET /connectors/{id}/deliveries` names `state=handled`, the server MUST list only the handled deliveries.

**Tests:** `compliance/inbound-webhooks.test.ts › lists oldest first by cursor, narrowed by state and endpoint`.

### `inbound-webhooks/deliveries-state-any`

When `GET /connectors/{id}/deliveries` names `state=any`, the server MUST list the handled and the unhandled deliveries.

**Tests:** `compliance/inbound-webhooks.test.ts › lists oldest first by cursor, narrowed by state and endpoint`.

### `inbound-webhooks/deliveries-state-invalid`

If `GET /connectors/{id}/deliveries` names a `state` other than `pending`, `handled` or `any`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses a state it does not know, rather than answering the unhandled deliveries`.

### `inbound-webhooks/deliveries-endpoint-filter`

When `GET /connectors/{id}/deliveries` names an `endpoint_id`, the server MUST list only the deliveries that endpoint received.

**Tests:** `compliance/inbound-webhooks.test.ts › lists oldest first by cursor, narrowed by state and endpoint`.

### `inbound-webhooks/deliveries-endpoint-unheld`

When `GET /connectors/{id}/deliveries` names an `endpoint_id` the registration does not hold, the server MUST list none.

**Tests:** `compliance/inbound-webhooks.test.ts › reads and marks to the connector's own key alone`.

### `inbound-webhooks/deliveries-limit-default`

When `GET /connectors/{id}/deliveries` names no `limit`, the server MUST list at most 50 deliveries.

**Tests:** `compliance/connector-codes.test.ts › lists 50 deliveries and 50 agreements unless a limit is named, and up to 200 when it is`.

### `inbound-webhooks/deliveries-limit-bounds`

If `GET /connectors/{id}/deliveries` names a `limit` outside 1 to 200, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-codes.test.ts › refuses a limit outside 1 to 200 with validation_error on the runs, agreements and deliveries listings, and takes both ends`, `compliance/inbound-webhooks.test.ts › lists oldest first by cursor, narrowed by state and endpoint`.

### `inbound-webhooks/deliveries-paged`

When a `limit` cuts the list of deliveries short, the server MUST answer a `next_cursor` that reaches the rest.

**Tests:** `compliance/inbound-webhooks.test.ts › lists oldest first by cursor, narrowed by state and endpoint`.

### `inbound-webhooks/deliveries-undeclared-key`

If `GET /connectors/{id}/deliveries` names a query key the operation does not declare, then the server MUST answer `400 validation_error` with the key in `details.unknown_parameters`.

**Reason:** a misspelled `state` would otherwise answer the unhandled deliveries, which reads as a filter that matched.

**Tests:** `compliance/inbound-webhooks.test.ts › refuses a query key the listing does not declare, rather than answering unfiltered`.

### `inbound-webhooks/deliveries-own-key-only`

If a key that is not the connector's own, the operator key included, sends `GET /connectors/{id}/deliveries`, `GET /connectors/{id}/deliveries/{delivery_id}/body` or `POST /connectors/{id}/deliveries/handled`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/inbound-webhooks.test.ts › reads and marks to the connector's own key alone`.

### `inbound-webhooks/deliveries-other-keeps`

If the server refuses a key that is not the connector's own on `POST /connectors/{id}/deliveries/handled`, then the server MUST NOT mark a delivery.

**Tests:** `compliance/inbound-webhooks.test.ts › reads and marks to the connector's own key alone`.

### `inbound-webhooks/body-read`

When the connector's own key sends `GET /connectors/{id}/deliveries/{delivery_id}/body` for a delivery the registration holds, the server MUST answer the body byte for byte as `application/octet-stream`, whatever the sender declared.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`.

### `inbound-webhooks/body-unheld`

If `GET /connectors/{id}/deliveries/{delivery_id}/body` names a delivery the registration does not hold, another registration's delivery included, then the server MUST answer `404 delivery_not_found`.

**Tests:** `compliance/inbound-webhooks.test.ts › stores the body byte for byte, the headers as they arrived and the query as sent`, `compliance/connector-codes.test.ts › answers another connector's delivery, endpoint and registration with the code of each, and marks and retires nothing`.

## Marking deliveries handled

A mark says how the connector handled a delivery. The server records it and acts on nothing.

### `inbound-webhooks/handled-mark`

When the connector's own key sends `POST /connectors/{id}/deliveries/handled` with `ids` and an `outcome` of `processed`, `duplicate` or `rejected`, the server MUST mark each named delivery with `handled_at` and the outcome.

**Tests:** `compliance/inbound-webhooks.test.ts › keeps the first mark, and marks nothing when an id is not the connector's`, `› answers each id of a handled mark once, in the order first named`.

### `inbound-webhooks/handled-answer`

When the server marks deliveries handled, the server MUST answer `200` with `data` holding the named deliveries.

**Tests:** `compliance/inbound-webhooks.test.ts › keeps the first mark, and marks nothing when an id is not the connector's`, `› answers each id of a handled mark once, in the order first named`.

### `inbound-webhooks/handled-once-in-order`

When `POST /connectors/{id}/deliveries/handled` names a delivery more than once, the server MUST answer it once, in the order it was first named.

**Tests:** `compliance/inbound-webhooks.test.ts › answers each id of a handled mark once, in the order first named`.

### `inbound-webhooks/handled-first-stands`

When `POST /connectors/{id}/deliveries/handled` names a delivery that is marked already, the server MUST answer it with the mark it had.

**Tests:** `compliance/inbound-webhooks.test.ts › keeps the first mark, and marks nothing when an id is not the connector's`, `› answers each id of a handled mark once, in the order first named`.

### `inbound-webhooks/handled-unheld`

If a `POST /connectors/{id}/deliveries/handled` the server would otherwise take names a delivery the registration does not hold, another registration's delivery included, then the server MUST answer `404 delivery_not_found`.

**Tests:** `compliance/inbound-webhooks.test.ts › keeps the first mark, and marks nothing when an id is not the connector's`, `compliance/connector-codes.test.ts › answers another connector's delivery, endpoint and registration with the code of each, and marks and retires nothing`.

### `inbound-webhooks/handled-unheld-keeps`

If the server answers `404 delivery_not_found` to `POST /connectors/{id}/deliveries/handled`, then the server MUST NOT mark any delivery it named.

**Tests:** `compliance/inbound-webhooks.test.ts › keeps the first mark, and marks nothing when an id is not the connector's`, `compliance/connector-codes.test.ts › answers another connector's delivery, endpoint and registration with the code of each, and marks and retires nothing`.

### `inbound-webhooks/handled-ids-bounds`

If `POST /connectors/{id}/deliveries/handled` names fewer than 1 or more than 200 `ids`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/inbound-webhooks.test.ts › takes 200 ids in a handled mark, and refuses 201, none and a body that names too little`.

### `inbound-webhooks/handled-ids-at-cap`

When `POST /connectors/{id}/deliveries/handled` names 200 `ids`, the server MUST take the request.

**Tests:** `compliance/inbound-webhooks.test.ts › takes 200 ids in a handled mark, and refuses 201, none and a body that names too little`.

### `inbound-webhooks/handled-ids-missing`

If `POST /connectors/{id}/deliveries/handled` names no `ids`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/inbound-webhooks.test.ts › takes 200 ids in a handled mark, and refuses 201, none and a body that names too little`, `compliance/declared-refusals.test.ts › is refused 400 missing_required_field, naming the field`.

### `inbound-webhooks/handled-outcome-values`

If `POST /connectors/{id}/deliveries/handled` names an `outcome` other than `processed`, `duplicate` or `rejected`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/inbound-webhooks.test.ts › takes 200 ids in a handled mark, and refuses 201, none and a body that names too little`, `› keeps the first mark, and marks nothing when an id is not the connector's`.

### `inbound-webhooks/handled-outcome-missing`

If `POST /connectors/{id}/deliveries/handled` names no `outcome`, then the server MUST answer `400 missing_required_field` with `details.field` `outcome`.

**Tests:** `compliance/inbound-webhooks.test.ts › takes 200 ids in a handled mark, and refuses 201, none and a body that names too little`.

### `inbound-webhooks/handled-no-audit`

When the server marks a delivery handled, the server MUST NOT record an audit entry for it.

**Tests:** `compliance/inbound-webhooks.test.ts › audits a creation and a retirement once each, and neither a receipt nor a handled mark`.

## Repeated deliveries

A sender may send one delivery more than once. An endpoint made with a `duplicate_header` marks a repeat of that header's value, and the server stores both.

### `inbound-webhooks/duplicate-of`

When a delivery carries a value in its endpoint's duplicate header that an earlier delivery the endpoint still retains carried, the server MUST give its `duplicate_of` as the `id` and `outcome` of the earliest retained delivery on the same endpoint that carried the value.

**Tests:** `compliance/inbound-webhooks.test.ts › marks a repeat of the duplicate header with the first delivery and how it was handled`.

### `inbound-webhooks/duplicate-outcome`

When the server gives `duplicate_of`, the server MUST give its `outcome` as how that delivery was handled, or `null` while it is unhandled.

**Reason:** the outcome is read when the list is answered, so a mark made later shows on the repeat.

**Tests:** `compliance/inbound-webhooks.test.ts › marks a repeat of the duplicate header with the first delivery and how it was handled`.

### `inbound-webhooks/duplicate-both-stored`

When a delivery repeats a value, the server MUST store both deliveries.

**Tests:** `compliance/inbound-webhooks.test.ts › marks a repeat of the duplicate header with the first delivery and how it was handled`.

### `inbound-webhooks/duplicate-new-value`

When a delivery carries a value in its endpoint's duplicate header that no earlier delivery the endpoint still retains carried, the server MUST give its `duplicate_of` as `null`.

**Tests:** `compliance/inbound-webhooks.test.ts › marks a repeat of the duplicate header with the first delivery and how it was handled`.

### `inbound-webhooks/duplicate-no-header-named`

When a delivery arrives at an endpoint made with no `duplicate_header`, the server MUST give its `duplicate_of` as `null`.

**Tests:** `compliance/inbound-webhooks.test.ts › marks a repeat of the duplicate header with the first delivery and how it was handled`.

### `inbound-webhooks/duplicate-header-absent`

When a delivery arrives without the header its endpoint names as `duplicate_header`, the server MUST give its `duplicate_of` as `null`.

**Tests:** `compliance/inbound-webhooks.test.ts › gives no duplicate_of to a delivery that arrives without its endpoint's duplicate header`.

### `inbound-webhooks/duplicate-other-endpoint`

When a delivery carries a value that only another endpoint of the registration carried, the server MUST give its `duplicate_of` as `null`.

**Tests:** `compliance/inbound-webhooks.test.ts › gives no duplicate_of to a delivery whose value only another endpoint of the registration carried`.

### `inbound-webhooks/duplicate-earliest-remaining`

When the earliest delivery that carried a value was removed by age, the server MUST give the `duplicate_of` of a later repeat as the earliest delivery that remains.

**Tests:** `compliance/inbound-retention.test.ts › marks a repeat against the earliest delivery that remains once the first of its value is removed`.

## What the instance says of itself

### `inbound-webhooks/feature-named`

The server MUST name `inbound_webhooks` among the `features` that `GET /` answers.

**Tests:** `compliance/instance.test.ts › describes itself at the root`.

## How long deliveries are kept

The retention of a handled delivery and of an unhandled one is a setting that `PUT /config` overrides. The range of an override is `housekeeping/retention-days-range`, and how `GET /config` reads and clears it are `instance/config-read-set` and `instance/config-omitted-removed`.

### `inbound-webhooks/retention-handled`

Where `PUT /config` names no `inbound_handled_retention_days`, when the `inbound-delivery-cleanup` job runs, the server MUST remove each delivery that was handled more than `MARFA_INBOUND_HANDLED_RETENTION_DAYS` days before, 7 days unless named.

**Reason:** a handled delivery ages from the time it was handled, not from the time it arrived.

**Tests:** `compliance/inbound-retention.test.ts › removes handled deliveries seven days after they were handled and pending ones thirty days after they arrived, and keeps the rest`.

### `inbound-webhooks/retention-handled-override`

Where `PUT /config` names `inbound_handled_retention_days`, when the `inbound-delivery-cleanup` job runs, the server MUST remove each delivery that was handled more than that many days before.

**Tests:** `compliance/inbound-retention.test.ts › ages each class by the retention the instance names for it, and by the default for one it does not`, `› keeps a class whose retention is zero, whatever its age`.

### `inbound-webhooks/retention-pending`

Where `PUT /config` names no `inbound_pending_retention_days`, when the `inbound-delivery-cleanup` job runs, the server MUST remove each unhandled delivery that arrived more than `MARFA_INBOUND_PENDING_RETENTION_DAYS` days before, 30 days unless named.

**Tests:** `compliance/inbound-retention.test.ts › removes handled deliveries seven days after they were handled and pending ones thirty days after they arrived, and keeps the rest`, `› ages each class by the retention the instance names for it, and by the default for one it does not`.

### `inbound-webhooks/retention-pending-override`

Where `PUT /config` names `inbound_pending_retention_days`, when the `inbound-delivery-cleanup` job runs, the server MUST remove each unhandled delivery that arrived more than that many days before.

**Tests:** `compliance/inbound-retention.test.ts › keeps a class whose retention is zero, whatever its age`.

### `inbound-webhooks/retention-config`

When `PUT /config` names `inbound_handled_retention_days` or `inbound_pending_retention_days` as an integer from 0 through 36500, the server MUST answer it at `GET /config` until a later `PUT /config` leaves it out.

**Reason:** any other value is refused as `housekeeping/retention-days-range` says.

**Tests:** `compliance/inbound-webhooks.test.ts › round trips retention overrides and refuses invalid values`.

### `inbound-webhooks/retention-within-kept`

When the `inbound-delivery-cleanup` job runs, the server MUST NOT remove a delivery that is within its retention.

**Tests:** `compliance/inbound-retention.test.ts › removes handled deliveries seven days after they were handled and pending ones thirty days after they arrived, and keeps the rest`, `› ages each class by the retention the instance names for it, and by the default for one it does not`.

### `inbound-webhooks/retention-zero-keeps`

Where the retention of handled deliveries or of unhandled ones is 0, when the `inbound-delivery-cleanup` job runs, the server MUST NOT remove a delivery of that kind by age.

**Reason:** a retention of 0 keeps a kind whatever its age, and it does not lift the retained limits of `inbound-webhooks/retained-limit-holds-without-expiry`.

**Tests:** `compliance/inbound-retention.test.ts › keeps a class whose retention is zero, whatever its age`.

## The cleanup job

`inbound-delivery-cleanup` is one of the jobs `housekeeping.md` lists, and the operator key runs it with `POST /housekeeping/inbound-delivery-cleanup/run`.

### `inbound-webhooks/cleanup-result`

When a run of `inbound-delivery-cleanup` finishes, the server MUST answer the run's `result` with `deleted`, the number of deliveries it removed, and `remaining`, whether deliveries past their retention are left.

**Tests:** `compliance/inbound-retention.test.ts › removes handled deliveries seven days after they were handled and pending ones thirty days after they arrived, and keeps the rest`, `› removes at most 500 deliveries in a pass, the oldest first, and says that work remains`.

### `inbound-webhooks/cleanup-batch`

When a run of `inbound-delivery-cleanup` finds more than 500 deliveries past their retention, the server MUST remove at most 500 of them.

**Reason:** a run is bounded so that a large backlog of expired deliveries is not drained in one unbroken write.

**Tests:** `compliance/inbound-retention.test.ts › removes at most 500 deliveries in a pass, the oldest first, and says that work remains`.

### `inbound-webhooks/cleanup-oldest-first`

When a run of `inbound-delivery-cleanup` removes deliveries, the server MUST remove the oldest first, by the time each one's age is counted from.

**Tests:** `compliance/inbound-retention.test.ts › removes at most 500 deliveries in a pass, the oldest first, and says that work remains`.

### `inbound-webhooks/cleanup-remaining`

When deliveries past their retention are left after a run of `inbound-delivery-cleanup`, the server MUST answer `remaining` `true`.

**Tests:** `compliance/inbound-retention.test.ts › removes at most 500 deliveries in a pass, the oldest first, and says that work remains`.

### `inbound-webhooks/cleanup-resumes`

When a later run of `inbound-delivery-cleanup` finds deliveries past their retention that an earlier run left, the server MUST remove them.

**Tests:** `compliance/inbound-retention.test.ts › removes at most 500 deliveries in a pass, the oldest first, and says that work remains`.

### `inbound-webhooks/cleanup-removes-body`

When the server removes a delivery by age, the server MUST remove its body, so that `GET /connectors/{id}/deliveries/{delivery_id}/body` answers `404`.

**Tests:** `compliance/inbound-retention.test.ts › removes handled deliveries seven days after they were handled and pending ones thirty days after they arrived, and keeps the rest`.

### `inbound-webhooks/cleanup-byte-target`

When the deliveries past their retention charge more than 33554432 bytes together, the server MUST remove in one run the oldest of them, in order, up to the last whose charge keeps the run's total at most 33554432 bytes.

**Tests:** `compliance/inbound-retention.test.ts › removes in one pass no more of the oldest than 32 MiB of their charges, taking a set of exactly 32 MiB`.

### `inbound-webhooks/cleanup-first-progresses`

When the oldest delivery past its retention alone charges more than 33554432 bytes, the server MUST remove it in a run.

**Reason:** a delivery larger than the byte target would otherwise never be removed.

**Tests:** `compliance/inbound-retention.test.ts › removes a delivery that alone charges more than 32 MiB, the oldest of those past their retention`.

### `inbound-webhooks/cleanup-rollback`

If a run of `inbound-delivery-cleanup` fails while it removes deliveries, then the server MUST keep every delivery it was removing, with its body.

**Tests:** waiting on #1444.

### `inbound-webhooks/cleanup-interval`

The server MUST list `inbound-delivery-cleanup` with an `interval_ms` of 60000 unless `MARFA_INBOUND_CLEANUP_INTERVAL_MS` names another.

**Tests:** `compliance/inbound-retention.test.ts › lists inbound-delivery-cleanup every 60000 milliseconds, or at the interval the instance names`.

## What the server writes to its log

An address is a credential, so a log that anyone can read must not hold one.

### `inbound-webhooks/log-address-redacted`

When the server logs a request to an inbound address, the server MUST write its path as `/inbound/****` and the last four characters of the address.

**Tests:** `compliance/inbound-logs.test.ts › writes no address, header, query or body of a receipt, where another door's path is written`.

### `inbound-webhooks/log-address-hidden`

When the server logs a request to an inbound address, the server MUST NOT write any character of the address but its last four, whatever the case of `/inbound/` in the request, whether a delivery was stored or refused.

**Tests:** `compliance/inbound-logs.test.ts › writes no address, header, query or body of a receipt, where another door's path is written`.

### `inbound-webhooks/log-no-content`

When the server logs a request to an inbound address, the server MUST NOT write a header, the query string or the body of the request.

**Tests:** `compliance/inbound-logs.test.ts › writes no address, header, query or body of a receipt, where another door's path is written`.

### `inbound-webhooks/fault-keeps-content`

If storing a receipt fails on a database fault, then the server MUST NOT carry the address, a header, the query string or the body of the receipt in its log, in a notification to the error webhook, in telemetry, on a span or in error tracking.

**Reason:** `errors/report-log-values` keeps the values a failed statement was bound to out of a report, and a receipt's address and content are among them.

**Tests:** waiting on #1444.

### `inbound-webhooks/contention`

If a receipt cannot get the store's write lock within the instance's busy budget, then the server MUST answer `503 write_contention`, as `errors/contention` says of a write.

**Reason:** a sender records the refusal as a failed delivery and sends it again.

**Tests:** `compliance/write-contention.test.ts › refuses an inbound receipt 503 write_contention and stores nothing, then takes the same receipt once the lock is gone`.

## The order of checks

Where one request meets two refusals, each rule below names the refusal the request is told first.

### `inbound-webhooks/order-address-first`

If a request posts to an address no live endpoint holds, then the server MUST answer `404 not_found`, whether the endpoint's window is spent, its registration's backlog is full or the request declares a length over the limit.

**Reason:** an address that is not live is told nothing about the instance's state.

**Tests:** `compliance/inbound-check-order.test.ts › answers an address no live endpoint holds 404 before the rate window and the declared length`.

### `inbound-webhooks/order-window-before-backlog`

While the limiter is on, if a request is past an endpoint's window and its registration's backlog of deliveries is full, then the server MUST answer `429 rate_limited`.

**Tests:** `compliance/inbound-check-order.test.ts › answers the rate window's 429 before the backlog's 503`.

### `inbound-webhooks/order-backlog-before-length`

If a request declares a `Content-Length` over the limit and its registration already holds `MARFA_INBOUND_BACKLOG_DELIVERIES` unhandled deliveries, then the server MUST answer `503 inbound_unavailable`.

**Tests:** `compliance/inbound-check-order.test.ts › answers a full backlog 503 before a declared length over the limit`.

### `inbound-webhooks/order-length-before-timeout`

If a request declares a `Content-Length` over the limit and sends none of the body, then the server MUST answer `413 request_too_large` and not `408 request_timeout`.

**Tests:** `compliance/inbound-check-order.test.ts › answers a declared length over the limit 413 before the body's 408`.

### `inbound-webhooks/order-limit-before-in-flight`

If the same part of a body takes it past the limit as it is read and would also take the bytes in flight past their limit, then the server MUST answer `413 request_too_large`.

**Tests:** `compliance/inbound-check-order.test.ts › answers a body read past the limit 413 before the bytes in flight's 503`.
