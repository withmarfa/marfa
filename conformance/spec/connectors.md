# Connectors

A connector is a process outside the server that registers under a key of its own, heartbeats, reports its runs, holds its registration so that one process at a time replaces its state or writes its agreements, and keeps what it needs to resume on the instance. The connector's own key is the key its registration was made under.

The webhook endpoints a registration owns are `inbound-webhooks.md`'s. The error envelope and the codes are `errors.md`'s, and the settings named here are `instance.md`'s.

## Registering

A registration belongs to one key, and a key holds one. The operator key and an access token an app holds register nothing.

### `connectors/register-created`

When a working key that has no registration sends `POST /connectors` with a `name`, the server MUST answer `201` with the registration's `id`, `key_id`, `source`, `name`, `description`, `registered_at`, `updated_at`, `last_heartbeat_at`, `last_run` and `hold_expires_at`.

**Tests:** `compliance/connectors.test.ts › registers the key as a connector and lists it`.

### `connectors/register-key-and-source`

When the server answers a registration, the server MUST give `key_id` as the id of the key that registered and `source` as that key's source.

**Tests:** `compliance/connectors.test.ts › registers the key as a connector and lists it`.

### `connectors/register-fresh-nulls`

While a registration has had no heartbeat or no run, the server MUST answer the field of what it has not had, `last_heartbeat_at` or `last_run`, as `null`.

**Tests:** `compliance/connectors.test.ts › registers the key as a connector and lists it`, `› lists none of a removed registration's runs under the next one its key makes`, `compliance/connector-session-token.test.ts › refuses an app's session token 403 on every door that admits the connector's key`.

### `connectors/register-name-bounds`

If `POST /connectors` names a `name` outside 1 to 200 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connectors.test.ts › refuses a name or a description outside the bounds`, `compliance/connector-codes.test.ts › leaves nothing behind when the operator key, a name or a description is refused`.

### `connectors/register-name-missing`

If `POST /connectors` names no `name`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/declared-refusals.test.ts › is refused 400 missing_required_field, naming the field`, `compliance/connector-codes.test.ts › leaves nothing behind when the operator key, a name or a description is refused`.

### `connectors/register-description-bounds`

If `POST /connectors` names a `description` of more than 2000 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connectors.test.ts › refuses a name or a description outside the bounds`, `compliance/connector-codes.test.ts › leaves nothing behind when the operator key, a name or a description is refused`.

### `connectors/register-operator-refused`

If the operator key sends `POST /connectors`, then the server MUST answer `403 forbidden`.

**Reason:** the operator key runs the instance and never acts as a connector.

**Tests:** `compliance/connectors.test.ts › refuses to register the operator key`, `compliance/key-management.test.ts › refuses a key that may not use a door 403 before it reads the request`.

### `connectors/register-token-refused`

If an access token an app holds sends `POST /connectors`, then the server MUST answer `403 forbidden`.

**Reason:** an access token is renewed on every refresh, so a registration keyed to one would be orphaned by the next.

**Tests:** `compliance/declared-refusals.test.ts › cannot register a connector`, `compliance/connector-session-token.test.ts › refuses an app's session token 403 on registration, leaving nothing registered`.

### `connectors/register-refused-nothing`

If the server refuses `POST /connectors`, then the server MUST NOT register the key that sent it.

**Tests:** `compliance/connector-codes.test.ts › leaves nothing behind when the operator key, a name or a description is refused`, `compliance/connector-session-token.test.ts › refuses an app's session token 403 on registration, leaving nothing registered`.

### `connectors/register-refused-no-audit`

If the server refuses `POST /connectors`, then the server MUST NOT record a `connector.register` audit entry for it.

**Tests:** `compliance/connector-codes.test.ts › leaves nothing behind when the operator key, a name or a description is refused`.

### `connectors/register-repeat`

When a key that already has a registration sends `POST /connectors`, the server MUST answer `200` with the `id` of that registration.

**Tests:** `compliance/connectors.test.ts › registers once per key, updating on repeat`.

### `connectors/register-repeat-sets`

When a key that already has a registration sends `POST /connectors` with a `name` and a `description`, the server MUST replace the registration's name and description with them.

**Tests:** `compliance/connectors.test.ts › registers once per key, updating on repeat`.

### `connectors/register-repeat-no-description`

When a key that already has a registration sends `POST /connectors` with no `description`, the server MUST clear the registration's description.

**Reason:** a repeat is the new registration in full, so an omitted description is not kept from the old one.

**Tests:** `compliance/connectors.test.ts › clears the description when a key registers again without one`.

### `connectors/register-repeat-registered-at`

When a key that already has a registration sends `POST /connectors`, the server MUST keep the registration's `registered_at`.

**Tests:** `compliance/connectors.test.ts › registers once per key, updating on repeat`.

### `connectors/register-repeat-updated-at`

When a key that already has a registration sends `POST /connectors`, the server MUST move the registration's `updated_at` later.

**Tests:** `compliance/connectors.test.ts › registers once per key, updating on repeat`.

### `connectors/register-concurrent`

When one key sends `POST /connectors` twice at once and has no registration, the server MUST answer one `201` and one `200`, both with the same `id`.

**Tests:** `compliance/connector-races.test.ts › answers one 201 and one 200, with one id, when a key registers twice at once`.

### `connectors/register-audited`

When a key registers, whether it is the first time or a repeat, the server MUST record a `connector.register` audit entry against the registration's id whose `details` carry the registration's `name` and whether the call created it as `created`.

**Tests:** `compliance/connectors.test.ts › audits every registration and a removal, not a heartbeat or a run`.

### `connectors/register-successor`

When a key minted under the source of a revoked key sends `POST /connectors`, the server MUST register it as a registration of its own, with an `id` and a `key_id` the revoked key's registration does not carry.

**Reason:** a source is unique among live keys only, and a registration belongs to its key, so a successor does not take the revoked key's registration over.

**Tests:** `compliance/connector-state.test.ts › hands the state and the agreements to the next key with the same source`.

## Reading registrations

`GET /connectors/{id}/runs` is held to the same reach as `GET /connectors/{id}`.

### `connectors/list-own-key`

When a working key sends `GET /connectors`, the server MUST list only the registration of its own key, and none when its key has none.

**Tests:** `compliance/connectors.test.ts › keeps registrations and runs to the own key or operator`.

### `connectors/list-operator`

When the operator key sends `GET /connectors`, the server MUST list every registration.

**Tests:** `compliance/connectors.test.ts › keeps registrations and runs to the own key or operator`, `› registers the key as a connector and lists it`.

### `connectors/list-newest-first`

When the server lists registrations, the server MUST list the newest registration first.

**Tests:** `compliance/connectors.test.ts › registers the key as a connector and lists it`.

### `connectors/list-entry-fields`

When the server lists registrations, the server MUST give each entry its `key_id`, its key's `source`, its `last_heartbeat_at`, its `last_run` and its `hold_expires_at`.

**Tests:** `compliance/connectors.test.ts › registers the key as a connector and lists it`, `› lists runs newest first and names the last on the registration`, `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`.

### `connectors/list-whole`

When a credential sends `GET /connectors`, the server MUST answer the whole list with `next_cursor` `null`.

**Reason:** the operation takes no `limit` and no `cursor`.

**Tests:** `compliance/envelope.test.ts › answers a null cursor from every door that takes none`.

### `connectors/read-registration`

When the connector's own key or the operator key sends `GET /connectors/{id}`, the server MUST answer `200` with the registration, as `POST /connectors` answers it.

**Tests:** `compliance/connectors.test.ts › keeps registrations and runs to the own key or operator`, `› registers the key as a connector and lists it`.

### `connectors/read-hidden`

If a working key that is not the connector's own sends `GET /connectors/{id}` or `GET /connectors/{id}/runs`, then the server MUST answer `404 connector_not_found`.

**Tests:** `compliance/connector-codes.test.ts › answers another connector's delivery, endpoint and registration with the code of each, and marks and retires nothing`, `compliance/connectors.test.ts › keeps registrations and runs to the own key or operator`.

### `connectors/read-hidden-as-absent`

If a working key that is not the connector's own sends `GET /connectors/{id}` or `GET /connectors/{id}/runs`, then the server MUST answer it exactly as it answers an id no registration carries.

**Reason:** a key learns nothing of another key's registrations from a refusal.

**Tests:** `compliance/connectors.test.ts › keeps registrations and runs to the own key or operator`, `compliance/connector-codes.test.ts › answers another connector's delivery, endpoint and registration with the code of each, and marks and retires nothing`.

### `connectors/unknown-id`

If a request to an operation under `/connectors/{id}` whose body and query fit the operation's declaration names an id no registration carries, then the server MUST answer `404 connector_not_found`.

**Reason:** a body or query that does not fit the declaration is refused first, as `connectors/order-body-before-registration` says.

**Tests:** `compliance/connectors.test.ts › answers 404 for an unknown connector, where a registered one answers`, `compliance/connector-check-order.test.ts › answers a registration that is not there 404 before the key's 403, on every door the key reaches`.

### `connectors/no-credential`

If a request to an operation under `/connectors` carries no credential and no body over the operation's cap or nested more than 64 levels, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`.

### `connectors/feature-named`

The server MUST name `connectors` among the `features` that `GET /` answers.

**Tests:** `compliance/instance.test.ts › describes itself at the root`.

## Removing a registration

The webhook endpoints and deliveries of a registration go with it, as `inbound-webhooks/endpoints-go-with-it` and `inbound-webhooks/deliveries-go-with-it` say.

### `connectors/delete-answer`

When the connector's own key or the operator key sends `DELETE /connectors/{id}`, the server MUST answer `200` with `ok` `true`.

**Tests:** `compliance/connectors.test.ts › removes a registration for its own key or the operator, never another`.

### `connectors/delete-removes`

When the server answers `DELETE /connectors/{id}` with `200`, the server MUST answer `GET /connectors/{id}` for that id with `404` from then on.

**Tests:** `compliance/connectors.test.ts › removes a registration for its own key or the operator, never another`.

### `connectors/delete-other-refused`

If a working key that is not the connector's own sends `DELETE /connectors/{id}`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connectors.test.ts › removes a registration for its own key or the operator, never another`.

### `connectors/delete-other-keeps`

If the server refuses `DELETE /connectors/{id}` to a working key that is not the connector's own, then the server MUST keep the registration.

**Tests:** `compliance/connectors.test.ts › removes a registration for its own key or the operator, never another`.

### `connectors/delete-removes-runs`

When a registration is removed and its key registers again, the server MUST list none of the old registration's runs under the new one.

**Tests:** `compliance/connectors.test.ts › lists none of a removed registration's runs under the next one its key makes`.

### `connectors/delete-removes-hold`

When a registration is removed and its key registers again, the server MUST NOT carry the old registration's hold over to the new one.

**Tests:** `compliance/connectors.test.ts › carries no hold over from a removed registration to the next one its key makes`.

### `connectors/delete-keeps-state`

When a registration is removed, the server MUST keep the state document and the agreements of its source.

**Reason:** they belong to the source, which a later key can register under.

**Tests:** `compliance/connector-state.test.ts › clears what a removed registration left, through a later registration of its source`.

### `connectors/delete-concurrent`

When two requests remove one registration at once, the server MUST answer one `200` and one `404 connector_not_found`.

**Tests:** `compliance/connector-races.test.ts › answers one 200 and one 404, and audits once, when a registration is removed twice at once`.

### `connectors/delete-audited`

When the server removes a registration, the server MUST record a `connector.delete` audit entry against the registration's id whose `details` carry the registration's `name`.

**Tests:** `compliance/connectors.test.ts › audits every registration and a removal, not a heartbeat or a run`.

### `connectors/delete-audited-once`

When two requests remove one registration at once, the server MUST record one `connector.delete` audit entry for it.

**Tests:** `compliance/connector-races.test.ts › answers one 200 and one 404, and audits once, when a registration is removed twice at once`.

## A registration that outlives its key

Revoking a key removes nothing the connector registered, and nothing supervises a registration whose process can no longer reach it.

### `connectors/revoked-registration-stays`

When a key is revoked, the server MUST keep its registration, and answer it to the operator key with the `key_id`, `source` and `last_heartbeat_at` it had.

**Tests:** `compliance/connectors.test.ts › keeps a registration whose key was revoked, until the operator removes it`, `compliance/connector-codes.test.ts › answers 401 unauthorized to a revoked key on every door, and leaves its runs to the operator`.

### `connectors/revoked-runs-stay`

When a key is revoked, the server MUST keep the runs its connector reported, and list them to the operator key.

**Tests:** `compliance/connector-codes.test.ts › answers 401 unauthorized to a revoked key on every door, and leaves its runs to the operator`.

### `connectors/revoked-unauthorized`

If a revoked key sends a request to any operation under `/connectors` with no body over the operation's cap or nested more than 64 levels, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/connector-codes.test.ts › answers 401 unauthorized to a revoked key on every door, and leaves its runs to the operator`, `compliance/connectors.test.ts › keeps a registration whose key was revoked, until the operator removes it`.

### `connectors/revoked-run-not-recorded`

If a revoked key sends `POST /connectors/{id}/runs`, then the server MUST NOT record a run.

**Tests:** `compliance/connector-codes.test.ts › answers 401 unauthorized to a revoked key on every door, and leaves its runs to the operator`.

## An access token an app holds

An access token is not a key, so no registration is made under one and none is the connector's own.

### `connectors/token-refused`

If an access token an app holds sends any operation under `/connectors/{id}` other than `GET /connectors/{id}` and `GET /connectors/{id}/runs`, naming a registration that exists, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connector-session-token.test.ts › refuses an app's session token 403 on every door that admits the connector's key`.

### `connectors/token-refused-changes-nothing`

If the server refuses an access token on an operation under `/connectors/{id}`, then the server MUST leave the registration, its hold, its state document, its agreements, its endpoints and its deliveries as they were.

**Tests:** `compliance/connector-session-token.test.ts › refuses an app's session token 403 on every door that admits the connector's key`.

### `connectors/token-list-empty`

When an access token an app holds sends `GET /connectors`, the server MUST answer `200` with an empty list.

**Tests:** `compliance/connector-session-token.test.ts › lists nothing to an app's session token, and hides a registration from it`.

### `connectors/token-hidden`

If an access token an app holds sends `GET /connectors/{id}` or `GET /connectors/{id}/runs` for a registration, then the server MUST answer `404 connector_not_found`, as it answers an id no registration carries.

**Tests:** `compliance/connector-session-token.test.ts › lists nothing to an app's session token, and hides a registration from it`.

## Heartbeats

A heartbeat says only that the process was alive at the time. What a stale one means is the reader's to decide.

### `connectors/heartbeat-recorded`

When the connector's own key sends `POST /connectors/{id}/heartbeat`, the server MUST answer `200` with `last_heartbeat_at`.

**Tests:** `compliance/connectors.test.ts › takes a heartbeat from the connector's key alone`.

### `connectors/heartbeat-clock`

When the server records a heartbeat, the server MUST give `last_heartbeat_at` as the time on its own clock.

**Tests:** `compliance/connector-codes.test.ts › stamps a heartbeat, a run's report and a receipt with its own clock`, `compliance/connectors.test.ts › takes a heartbeat from the connector's key alone`.

### `connectors/heartbeat-listed`

When the server has recorded a heartbeat, the server MUST give the registration that `last_heartbeat_at` when it answers the registration.

**Tests:** `compliance/connectors.test.ts › takes a heartbeat from the connector's key alone`.

### `connectors/heartbeat-other-refused`

If a key that is not the connector's own, the operator key included, sends `POST /connectors/{id}/heartbeat`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connectors.test.ts › takes a heartbeat from the connector's key alone`.

### `connectors/heartbeat-refused-keeps`

If the server refuses `POST /connectors/{id}/heartbeat`, then the server MUST NOT move the registration's `last_heartbeat_at`.

**Tests:** `compliance/connectors.test.ts › takes a heartbeat from the connector's key alone`.

### `connectors/heartbeat-no-hold`

When the server records a heartbeat, the server MUST NOT take the registration's hold for any process.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`.

### `connectors/heartbeat-no-audit`

When the server records a heartbeat, the server MUST NOT record an audit entry for it.

**Tests:** `compliance/connectors.test.ts › audits every registration and a removal, not a heartbeat or a run`.

## Runs

A run is what a connector reports of one pass of its work. The server keeps the last 100 of them for each registration.

### `connectors/run-created`

When the connector's own key sends `POST /connectors/{id}/runs` with an `outcome`, a `started_at` and a `finished_at`, the server MUST answer `201` with the run's `id`, `connector_id`, `outcome`, `started_at`, `finished_at`, `summary`, `error` and `reported_at`.

**Tests:** `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`.

### `connectors/run-optional-null`

When the connector's own key reports a run without a `summary` or without an `error`, the server MUST answer the one it left out as `null`.

**Tests:** `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`.

### `connectors/run-reported-at`

When the server records a run, the server MUST give `reported_at` as the time on its own clock, whatever times the run names.

**Tests:** `compliance/connector-codes.test.ts › stamps a heartbeat, a run's report and a receipt with its own clock`.

### `connectors/run-outcome-values`

If a run names an `outcome` other than `succeeded` or `failed`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`.

### `connectors/run-outcome-missing`

If a run names no `outcome`, then the server MUST answer `400 missing_required_field` with `details.field` `outcome`.

**Tests:** `compliance/connectors.test.ts › names a missing outcome as missing_required_field, where a wrong one is a validation_error`.

### `connectors/run-time-missing`

If a run names no `started_at` or no `finished_at`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/declared-refusals.test.ts › is refused 400 missing_required_field, naming the field`.

### `connectors/run-time-invalid`

If a run names a `started_at` or a `finished_at` that is not a timestamp, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`.

### `connectors/run-time-year`

If a run names a `started_at` or a `finished_at` whose UTC year is outside 0000 to 9999, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connectors.test.ts › refuses a run time whose UTC year is outside 0000 to 9999, and takes the first and last instants`.

### `connectors/run-finish-before-start`

If a run names a `finished_at` before its `started_at`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`, `› stores a run's times in UTC and compares them as instants`.

### `connectors/run-text-bounds`

If a run names a `summary` or an `error` of more than 2000 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`.

### `connectors/run-times-utc`

When the server records a run, the server MUST answer its `started_at` and `finished_at`, on the `201` and in `GET /connectors/{id}/runs`, in UTC at millisecond precision as `YYYY-MM-DDTHH:mm:ss.sssZ`, whatever offset or precision was sent.

**Reason:** every other time Marfa answers is in this one form, so a client that sorts or compares runs by text gets time order.

**Tests:** `compliance/connectors.test.ts › stores a run's times in UTC and compares them as instants`.

### `connectors/run-times-zoneless`

When a run names a time with no zone, the server MUST read it as UTC, as `items/occurred-at-zoneless` does for `occurred_at`.

**Tests:** `compliance/connectors.test.ts › stores a run's times in UTC and compares them as instants`.

### `connectors/run-times-instants`

When the server decides whether a run's `finished_at` is before its `started_at`, the server MUST compare the two as instants.

**Tests:** `compliance/connectors.test.ts › stores a run's times in UTC and compares them as instants`.

### `connectors/run-other-refused`

If a key that is not the connector's own, the operator key included, sends `POST /connectors/{id}/runs`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`.

### `connectors/run-refused-not-recorded`

If the server refuses `POST /connectors/{id}/runs`, then the server MUST NOT record a run.

**Tests:** `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`.

### `connectors/run-no-audit`

When the server records a run, the server MUST NOT record an audit entry for it.

**Tests:** `compliance/connectors.test.ts › audits every registration and a removal, not a heartbeat or a run`.

### `connectors/runs-own-or-operator`

When the connector's own key or the operator key sends `GET /connectors/{id}/runs`, the server MUST list the runs of that registration.

**Tests:** `compliance/connectors.test.ts › keeps registrations and runs to the own key or operator`.

### `connectors/runs-newest-first`

When the server lists runs, the server MUST list them newest first by `reported_at`.

**Tests:** `compliance/connectors.test.ts › lists runs newest first and names the last on the registration`.

### `connectors/runs-limit-default`

When `GET /connectors/{id}/runs` names no `limit`, the server MUST list at most 50 runs.

**Tests:** `compliance/connectors.test.ts › keeps the last hundred runs`.

### `connectors/runs-limit-bounds`

If `GET /connectors/{id}/runs` names a `limit` outside 1 to 200, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-codes.test.ts › refuses a limit outside 1 to 200 with validation_error on the runs, agreements and deliveries listings, and takes both ends`, `compliance/connectors.test.ts › keeps the last hundred runs`.

### `connectors/runs-paged`

When a `limit` cuts the list of runs short, the server MUST answer a `next_cursor` that reaches the rest.

**Tests:** `compliance/connectors.test.ts › lists runs newest first and names the last on the registration`.

### `connectors/runs-undeclared-key`

If `GET /connectors/{id}/runs` names a query key the operation does not declare, then the server MUST answer `400 validation_error` with the key in `details.unknown_parameters`.

**Reason:** a misspelled filter would otherwise answer every run, which reads as a filter that matched them all.

**Tests:** `compliance/connectors.test.ts › refuses a query key the runs listing does not declare`.

### `connectors/runs-keep-hundred`

When a registration has 100 runs and a run is reported, the server MUST drop the run reported earliest.

**Tests:** `compliance/connectors.test.ts › keeps the last hundred runs`.

### `connectors/last-run`

When the server answers a registration, the server MUST give `last_run` as the newest run in the order of `connectors/runs-newest-first`.

**Tests:** `compliance/connectors.test.ts › lists runs newest first and names the last on the registration`.

## The hold

A hold is a lock a process takes under a name it chose, renews before it lapses, and gives up. Nothing watches it, so it lapses when the process stops renewing it.

### `connectors/hold-take`

When the connector's own key sends `POST /connectors/{id}/hold` with a `process` of 1 to 100 characters and no live hold names another process, the server MUST answer `200` with `expires_at`, `ttl_ms` and `renewed`.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`, `› refuses a process outside its bounds`.

### `connectors/hold-window`

When the server takes or renews a hold, the server MUST give `expires_at` as its own clock plus the hold window, 180000 milliseconds unless `MARFA_CONNECTOR_HOLD_MS` names another.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`, `› lets another process take a hold that lapsed, and takes its writes once it holds it`.

### `connectors/hold-ttl`

When the server takes or renews a hold, the server MUST give `ttl_ms` as the hold window in milliseconds.

**Reason:** a process learns how long it holds without reading the server's clock.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`, `› tells a process whose hold lapsed that it did not renew it`.

### `connectors/hold-renew`

When the process that holds a live hold sends `POST /connectors/{id}/hold`, the server MUST move `expires_at` later and answer `renewed` `true`.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`, `› tells a process whose hold lapsed that it did not renew it`.

### `connectors/hold-first-not-renewed`

When a process takes a hold nothing holds, the server MUST answer `renewed` `false`.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`, `› tells a process whose hold lapsed that it did not renew it`.

### `connectors/hold-lapsed-not-renewed`

When a process takes a hold after its own hold lapsed, the server MUST answer `renewed` `false`, whether or not another process held the registration in between.

**Reason:** a process answered `renewed` `false` while it believed it held the registration may have been displaced, and re-reads its state and agreements before it writes again.

**Tests:** `compliance/connector-state.test.ts › tells a process whose hold lapsed that it did not renew it`.

### `connectors/hold-live`

While a hold is live, the server MUST answer the registration's `hold_expires_at` as that hold's `expires_at`, on the registration's own read and in the list.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`.

### `connectors/hold-none`

While no process holds a live hold, because none was taken, it was released or it lapsed, the server MUST answer the registration's `hold_expires_at` as `null`.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`, `› releases the hold for its holder alone, and answers the same when there is nothing to release`, `› lets another process take a hold that lapsed, and takes its writes once it holds it`.

### `connectors/hold-no-heartbeat`

When the server takes or renews a hold, the server MUST NOT move the registration's `last_heartbeat_at`.

**Tests:** `compliance/connector-state.test.ts › takes and renews the hold for one process, and shows it on the registration`.

### `connectors/hold-held-by-other`

If a process sends `POST /connectors/{id}/hold` while another process holds a live hold, then the server MUST answer `409 connector_held` with that hold's `expires_at` in `details.expires_at`.

**Tests:** `compliance/connector-state.test.ts › refuses a second process while the hold is live`, `› lets another process take a hold that lapsed, and takes its writes once it holds it`.

### `connectors/hold-held-keeps`

If the server refuses a take because another process holds a live hold, then the server MUST NOT move that hold.

**Tests:** `compliance/connector-state.test.ts › refuses a second process while the hold is live`.

### `connectors/hold-lapsed-taken`

When a hold's `expires_at` has passed, the server MUST let any process take the hold.

**Tests:** `compliance/connector-state.test.ts › lets another process take a hold that lapsed, and takes its writes once it holds it`.

### `connectors/hold-concurrent`

When two processes take a hold nothing holds at once, the server MUST answer one `200` and one `409 connector_held`.

**Tests:** `compliance/connector-races.test.ts › gives the hold to exactly one of two processes that take it at once`.

### `connectors/hold-process-bounds`

If `POST /connectors/{id}/hold` names a `process` outside 1 to 100 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a process outside its bounds`.

### `connectors/hold-process-missing`

If `POST /connectors/{id}/hold` names no `process`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/connector-state.test.ts › refuses a process outside its bounds`.

### `connectors/undeclared-body-field`

If an operation under `/connectors` that takes a body carries a top-level body field the operation does not declare and that does not start with an underscore, then the server MUST answer `400 validation_error` with the field in `details.unknown_body_fields`.

**Reason:** a misspelled field would otherwise be dropped, and the request read as something it did not say.

**Tests:** `compliance/connector-codes.test.ts › refuses a body field it does not declare, on every connector and inbound operation that takes a body`, `compliance/connector-state.test.ts › refuses a top-level body field the hold, the state and the find doors do not declare`, `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/hold-refused-keeps`

If the server refuses a take with `400`, then the server MUST NOT take or move the hold.

**Tests:** `compliance/connector-state.test.ts › refuses a process outside its bounds`, `› refuses a top-level body field the hold, the state and the find doors do not declare`.

### `connectors/hold-other-refused`

If a key that is not the connector's own, the operator key included, sends `POST /connectors/{id}/hold`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connector-state.test.ts › holds for the connector's own key alone`.

### `connectors/hold-other-keeps`

If the server refuses a take or a release to a key that is not the connector's own, then the server MUST NOT move the hold.

**Tests:** `compliance/connector-state.test.ts › holds for the connector's own key alone`.

### `connectors/release-answer`

When the connector's own key sends `DELETE /connectors/{id}/hold` with a `process` of 1 to 100 characters, the server MUST answer `200` with `ok` `true`, whether or not that process holds the hold.

**Tests:** `compliance/connector-state.test.ts › releases the hold for its holder alone, and answers the same when there is nothing to release`.

### `connectors/release-holder`

When the process that holds a live hold is named by `DELETE /connectors/{id}/hold`, the server MUST release the hold.

**Tests:** `compliance/connector-state.test.ts › releases the hold for its holder alone, and answers the same when there is nothing to release`.

### `connectors/release-other-keeps`

When `DELETE /connectors/{id}/hold` names a process that does not hold the hold, the server MUST leave the hold of the process that does.

**Tests:** `compliance/connector-state.test.ts › releases the hold for its holder alone, and answers the same when there is nothing to release`.

### `connectors/release-process-bounds`

If `DELETE /connectors/{id}/hold` names a `process` outside 1 to 100 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a process outside its bounds`.

### `connectors/release-process-missing`

If `DELETE /connectors/{id}/hold` names no `process`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/connector-state.test.ts › refuses a process outside its bounds`.

### `connectors/release-other-refused`

If a key that is not the connector's own, the operator key included, sends `DELETE /connectors/{id}/hold`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connector-state.test.ts › holds for the connector's own key alone`.

## The state document

A state document is the JSON object a connector keeps on the instance to resume from. It belongs to the registration's source, not to the registration or its key.

### `connectors/state-empty`

While nothing has been written to a source's state document, the server MUST answer `GET /connectors/{id}/state` with `state` `{}` and `updated_at` `null`.

**Tests:** `compliance/connector-state.test.ts › reads an empty state, and replaces it whole`.

### `connectors/state-replace`

When the connector's own key sends `PUT /connectors/{id}/state` with a `process` that holds a live hold and a `state` that is a JSON object, the server MUST replace the source's state document with it and answer the document with its `updated_at`.

**Tests:** `compliance/connector-state.test.ts › reads an empty state, and replaces it whole`, `› fences the state and the agreements to the process that holds the registration`.

### `connectors/state-updated-at`

When the server replaces a state document, the server MUST give its `updated_at` a time later than that of the previous write.

**Tests:** `compliance/connector-state.test.ts › reads an empty state, and replaces it whole`.

### `connectors/state-keys-as-sent`

When the server keeps a state document, the server MUST answer it key for key as it was sent, a top-level `__proto__` key among the rest.

**Tests:** `compliance/connector-state.test.ts › keeps a top-level __proto__ key in the state and in a record as sent`.

### `connectors/record-keys-as-sent`

When the server keeps an agreement's `record`, the server MUST answer it key for key as it was sent, a top-level `__proto__` key among the rest.

**Tests:** `compliance/connector-state.test.ts › keeps a top-level __proto__ key in the state and in a record as sent`.

### `connectors/state-over-cap`

If `PUT /connectors/{id}/state` names a `state` of more than 512 KiB serialized in a body within the request cap, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a state over its cap and takes one at it`, `compliance/connector-bounds.test.ts › takes a state body of exactly the request cap, refuses a state over its own cap inside it, and answers 413 to one byte more`.

### `connectors/state-at-cap`

When `PUT /connectors/{id}/state` names a `state` of exactly 512 KiB serialized, the server MUST take it.

**Tests:** `compliance/connector-state.test.ts › refuses a state over its cap and takes one at it`.

### `connectors/state-body-over-cap`

If a body sent to `PUT /connectors/{id}/state` is larger than the request cap, 1048576 bytes unless `MARFA_MAX_REQUEST_BYTES` names another, then the server MUST answer `413 request_too_large`.

**Reason:** a state of more than 512 KiB serialized in a body within the request cap is the state's own refusal, `connectors/state-over-cap`, and a larger body is the cap's.

**Tests:** `compliance/connector-bounds.test.ts › takes a state body of exactly the request cap, refuses a state over its own cap inside it, and answers 413 to one byte more`, `› takes an agreements batch past the request cap, and one of exactly the bulk cap, and answers 413 to one byte more`.

### `connectors/state-body-at-cap`

When a body sent to `PUT /connectors/{id}/state` is exactly the request cap and names a `state` within its own cap, the server MUST take it.

**Tests:** `compliance/connector-bounds.test.ts › takes a state body of exactly the request cap, refuses a state over its own cap inside it, and answers 413 to one byte more`.

### `connectors/state-not-object`

If `PUT /connectors/{id}/state` names a `state` that is not a JSON object, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › reads an empty state, and replaces it whole`.

### `connectors/state-process-bounds`

If `PUT /connectors/{id}/state` names a `process` outside 1 to 100 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › reads an empty state, and replaces it whole`.

### `connectors/state-missing-field`

If `PUT /connectors/{id}/state` names no `process` or no `state`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/connector-state.test.ts › reads an empty state, and replaces it whole`.

### `connectors/state-refusal-keeps`

If the server refuses `PUT /connectors/{id}/state`, then the server MUST leave the state document as it was.

**Tests:** `compliance/connector-state.test.ts › reads an empty state, and replaces it whole`, `› refuses a state over its cap and takes one at it`, `› refuses a top-level body field the hold, the state and the find doors do not declare`, `compliance/connector-bounds.test.ts › takes a state body of exactly the request cap, refuses a state over its own cap inside it, and answers 413 to one byte more`.

### `connectors/state-own-key-only`

If a key that is not the connector's own, the operator key included, sends `GET /connectors/{id}/state`, `PUT /connectors/{id}/state`, `POST /connectors/{id}/agreements`, `POST /connectors/{id}/agreements/lookup` or `GET /connectors/{id}/agreements`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connector-state.test.ts › keeps state and agreements to the connector's own key`.

### `connectors/state-other-keeps`

If the server refuses a key that is not the connector's own on an operation that reads or writes state or agreements, then the server MUST leave the state document and the agreements as they were.

**Tests:** `compliance/connector-state.test.ts › keeps state and agreements to the connector's own key`.

## Whose state it is

A source is the label a key is minted under. Two registrations of one source, one after the other, share a state document and agreements.

### `connectors/source-successor`

When a key minted under a source registers after the key that kept state under that source was revoked, the server MUST give it the same state document and the same agreements, whether or not the revoked key's registration still stands.

**Tests:** `compliance/connector-state.test.ts › hands the state and the agreements to the next key with the same source`, `› clears what a removed registration left, through a later registration of its source`.

### `connectors/source-reads-apart`

When a connector of one source reads its state document or its agreements, the server MUST NOT answer what a connector of another source kept.

**Tests:** `compliance/connector-state.test.ts › keeps each source's state and agreements apart`.

### `connectors/source-writes-apart`

When a connector of one source writes or clears its state document or its agreements, the server MUST NOT change what a connector of another source kept.

**Tests:** `compliance/connector-state.test.ts › keeps each source's state and agreements apart`.

### `connectors/source-records-apart`

When two connectors of different sources each write an agreement for one row, the server MUST keep a record for each and answer each its own.

**Tests:** `compliance/connector-state.test.ts › keeps each source's state and agreements apart`.

## Clearing what a source kept

`DELETE /connectors/{id}/state` is the one operation under a registration's state that the operator key reaches.

### `connectors/clear-answer`

When the connector's own key or the operator key sends `DELETE /connectors/{id}/state`, the server MUST answer `200` with `ok` `true`.

**Tests:** `compliance/connector-state.test.ts › clears the state and the agreements for the own key or the operator, and audits it`.

### `connectors/clear-state`

When the connector's own key or the operator key clears a registration's state, the server MUST remove the source's state document.

**Tests:** `compliance/connector-state.test.ts › clears the state and the agreements for the own key or the operator, and audits it`.

### `connectors/clear-agreements`

When the connector's own key or the operator key clears a registration's state, the server MUST remove every agreement of the source.

**Tests:** `compliance/connector-state.test.ts › clears the state and the agreements for the own key or the operator, and audits it`.

### `connectors/clear-unfenced`

When the connector's own key or the operator key clears a registration's state while a process holds a live hold, the server MUST clear it.

**Reason:** a clear names no process, so no hold fences it.

**Tests:** `compliance/connector-state.test.ts › clears the state and the agreements for the own key or the operator, and audits it`, `› hands the state and the agreements to the next key with the same source`.

### `connectors/clear-operator-whole-source`

When the operator key clears through any registration of a source, a registration whose key was revoked included, the server MUST remove the whole store of that source, a successor's live state among it.

**Tests:** `compliance/connector-state.test.ts › hands the state and the agreements to the next key with the same source`.

### `connectors/clear-after-removal`

When a key registers under a source whose earlier registration was removed and the operator key clears through the new registration, the server MUST remove what the earlier registration left.

**Reason:** nothing else removes what a removed registration left, so a source's store is cleared through a registration of that source.

**Tests:** `compliance/connector-state.test.ts › clears what a removed registration left, through a later registration of its source`.

### `connectors/clear-other-refused`

If a working key that is not the connector's own sends `DELETE /connectors/{id}/state`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connector-state.test.ts › clears the state and the agreements for the own key or the operator, and audits it`.

### `connectors/clear-other-keeps`

If the server refuses `DELETE /connectors/{id}/state` to a working key that is not the connector's own, then the server MUST keep the state document and the agreements.

**Tests:** `compliance/connector-state.test.ts › clears the state and the agreements for the own key or the operator, and audits it`.

### `connectors/clear-audited`

When the server clears a source's state, the server MUST record a `connector_state.delete` audit entry against the registration the request named, under the key that cleared it.

**Tests:** `compliance/connector-state.test.ts › clears the state and the agreements for the own key or the operator, and audits it`, `› hands the state and the agreements to the next key with the same source`.

### `connectors/clear-audit-details`

When the server records a `connector_state.delete` audit entry, the server MUST carry the `source`, whether a state document went as `state`, and the number of agreements removed as `agreements` in its `details`.

**Tests:** `compliance/connector-state.test.ts › clears the state and the agreements for the own key or the operator, and audits it`, `› goes with a purged row`.

## Writing agreements

An agreement is a connector's record of what it and its vendor last agreed about one row, one for each row and source. Writing one announces nothing and leaves the row alone.

### `connectors/agreements-written`

When the connector's own key sends `POST /connectors/{id}/agreements` with a `process` that holds a live hold, the server MUST answer `200` with `written`, `cleared` and `skipped`.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`.

### `connectors/agreements-set`

When `POST /connectors/{id}/agreements` names a row in `set` with its `waiting` and its `record`, the server MUST replace that row's agreement with them.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`.

### `connectors/agreements-clear`

When `POST /connectors/{id}/agreements` names a row in `clear`, the server MUST remove that row's agreement.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`.

### `connectors/agreements-skip-absent`

If an id in `set` or `clear` names no stored row, then the server MUST name it in `skipped`, in the order named, and not refuse the batch.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`, `› refuses a batch over its caps and writes nothing`.

### `connectors/agreements-skip-unreadable`

If an id in `set` or `clear` names a row whose type the key's type map does not read, then the server MUST skip it as it skips an id that names no stored row.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`, `› leaves a row the key no longer reads out of its reads and its clears`.

### `connectors/agreements-trashed`

When an id in `set` or `clear` names a trashed row, the server MUST write or clear its agreement as it does a live row's.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`.

### `connectors/agreements-set-cap`

If `POST /connectors/{id}/agreements` names more than 500 entries in `set`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-clear-cap`

If `POST /connectors/{id}/agreements` names more than 500 ids in `clear`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-batch-at-cap`

When `POST /connectors/{id}/agreements` names 500 entries in `set` or 500 ids in `clear`, the server MUST take the batch.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-record-cap`

If an entry of `set` names a `record` of more than 16 KiB serialized, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-record-at-cap`

When an entry of `set` names a `record` of exactly 16 KiB serialized, the server MUST take it.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-record-object`

If an entry of `set` names a `record` that is not a JSON object, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-waiting-boolean`

If an entry of `set` names a `waiting` that is not a boolean, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-named-twice`

If `POST /connectors/{id}/agreements` names one row twice, within `set` or `clear` or across the two, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-item-id-bounds`

If `POST /connectors/{id}/agreements` names an `item_id` or an id in `clear` outside 1 to 200 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses an item id outside 1 to 200 characters in a batch of agreements, and takes one at both ends`.

### `connectors/agreements-process-bounds`

If `POST /connectors/{id}/agreements` names a `process` outside 1 to 100 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a process outside 1 to 100 characters on a write of agreements, whether or not it holds the connector`.

### `connectors/agreements-missing-field`

If `POST /connectors/{id}/agreements` names no `process`, or an entry of `set` names no `item_id`, `waiting` or `record`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/agreements-refusal-keeps`

If the server refuses `POST /connectors/{id}/agreements` with `400`, then the server MUST write and clear no agreement of the batch.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`, `compliance/connector-check-order.test.ts › answers a state or a batch the door refuses 400 before the fence's 409`.

### `connectors/agreements-body-past-request-cap`

When `POST /connectors/{id}/agreements` carries a body larger than the request cap and no larger than the bulk cap, the server MUST take the batch.

**Reason:** a batch of 500 records of 16 KiB is larger than the request cap, and the bulk cap, 16777216 bytes unless `MARFA_MAX_BULK_REQUEST_BYTES` names another, is the one this operation has.

**Tests:** `compliance/connector-bounds.test.ts › takes an agreements batch past the request cap, and one of exactly the bulk cap, and answers 413 to one byte more`.

### `connectors/agreements-body-at-bulk-cap`

When `POST /connectors/{id}/agreements` carries a body of exactly the bulk cap, the server MUST take the batch.

**Tests:** `compliance/connector-bounds.test.ts › takes an agreements batch past the request cap, and one of exactly the bulk cap, and answers 413 to one byte more`.

### `connectors/agreements-body-over-bulk-cap`

If `POST /connectors/{id}/agreements` carries a body larger than the bulk cap, then the server MUST answer `413 request_too_large`.

**Tests:** `compliance/connector-bounds.test.ts › takes an agreements batch past the request cap, and one of exactly the bulk cap, and answers 413 to one byte more`.

### `connectors/agreements-silent-live`

When the server writes or clears an agreement, the server MUST NOT announce it on the event stream.

**Tests:** `compliance/connector-state.test.ts › writes an agreement without touching the row or announcing it`.

### `connectors/agreements-silent-replay`

When the server writes or clears an agreement, the server MUST NOT carry it in a replay from a cursor taken before the write.

**Tests:** `compliance/connector-state.test.ts › writes an agreement without touching the row or announcing it`.

### `connectors/agreements-keep-updated-at`

When the server writes or clears an agreement, the server MUST keep the row's `updated_at`.

**Tests:** `compliance/connector-state.test.ts › writes an agreement without touching the row or announcing it`.

### `connectors/agreements-keep-version`

When the server writes or clears an agreement, the server MUST keep the row's `version`.

**Tests:** `compliance/connector-state.test.ts › writes an agreement without touching the row or announcing it`.

### `connectors/agreements-trash-keeps`

When a row is trashed, the server MUST keep its agreement.

**Tests:** `compliance/connector-state.test.ts › goes with a purged row`.

### `connectors/agreements-purge-removes`

When a row is purged, the server MUST remove its agreement.

**Reason:** the reads leave out a row that is gone, so only the count of a later clear shows it.

**Tests:** `compliance/connector-state.test.ts › goes with a purged row`.

## Reading agreements

### `connectors/lookup-answer`

When the connector's own key sends `POST /connectors/{id}/agreements/lookup` with 1 to 500 `item_ids`, the server MUST answer `200` with `data` holding the agreement of each named row that has one.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`, `› finds agreements by row and lists the waiting ones a page at a time`.

### `connectors/lookup-once-in-order`

When `POST /connectors/{id}/agreements/lookup` names a row more than once, the server MUST answer its agreement once, in the order the row was first named.

**Tests:** `compliance/connector-state.test.ts › answers each row a lookup names once, in the order it was first named`.

### `connectors/lookup-fields`

When the server answers an agreement, the server MUST give its `item_id`, `waiting`, `record` and `updated_at`.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`.

### `connectors/lookup-no-cursor`

When the server answers `POST /connectors/{id}/agreements/lookup`, the server MUST answer no `next_cursor`.

**Tests:** `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`.

### `connectors/lookup-bounds`

If `POST /connectors/{id}/agreements/lookup` names fewer than 1 or more than 500 `item_ids`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/lookup-item-id-bounds`

If `POST /connectors/{id}/agreements/lookup` names an id in `item_ids` outside 1 to 200 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › refuses an item id outside 1 to 200 characters in a lookup, and takes one at both ends`.

### `connectors/lookup-missing`

If `POST /connectors/{id}/agreements/lookup` names no `item_ids`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/connector-state.test.ts › refuses a batch over its caps and writes nothing`.

### `connectors/lookup-unreadable`

When a row's type is one the key's type map does not read, the server MUST leave its agreement out of `POST /connectors/{id}/agreements/lookup`.

**Tests:** `compliance/connector-state.test.ts › leaves a row the key no longer reads out of its reads and its clears`, `› writes and clears agreements, skipping an id it cannot hold`.

### `connectors/list-agreements-order`

When the server lists agreements, the server MUST list the agreement written longest ago first.

**Tests:** `compliance/connector-state.test.ts › finds agreements by row and lists the waiting ones a page at a time`.

### `connectors/list-agreements-waiting`

When `GET /connectors/{id}/agreements` names `waiting=true`, the server MUST list only the agreements whose `waiting` is `true`.

**Tests:** `compliance/connector-state.test.ts › finds agreements by row and lists the waiting ones a page at a time`.

### `connectors/list-agreements-settled`

When `GET /connectors/{id}/agreements` names `waiting=false`, the server MUST list only the agreements whose `waiting` is `false`.

**Tests:** `compliance/connector-state.test.ts › finds agreements by row and lists the waiting ones a page at a time`.

### `connectors/list-agreements-waiting-invalid`

If `GET /connectors/{id}/agreements` names a `waiting` that is neither `true` nor `false`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-state.test.ts › finds agreements by row and lists the waiting ones a page at a time`.

### `connectors/list-agreements-limit-default`

When `GET /connectors/{id}/agreements` names no `limit`, the server MUST list at most 50 agreements.

**Tests:** `compliance/connector-codes.test.ts › lists 50 deliveries and 50 agreements unless a limit is named, and up to 200 when it is`.

### `connectors/list-agreements-limit-bounds`

If `GET /connectors/{id}/agreements` names a `limit` outside 1 to 200, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-codes.test.ts › refuses a limit outside 1 to 200 with validation_error on the runs, agreements and deliveries listings, and takes both ends`, `compliance/connector-state.test.ts › finds agreements by row and lists the waiting ones a page at a time`.

### `connectors/list-agreements-paged`

When a `limit` cuts the list of agreements short, the server MUST answer a `next_cursor` that reaches the rest.

**Tests:** `compliance/connector-state.test.ts › finds agreements by row and lists the waiting ones a page at a time`.

### `connectors/list-agreements-undeclared-key`

If `GET /connectors/{id}/agreements` names a query key the operation does not declare, then the server MUST answer `400 validation_error` with the key in `details.unknown_parameters`.

**Tests:** `compliance/connector-state.test.ts › finds agreements by row and lists the waiting ones a page at a time`.

### `connectors/list-agreements-unreadable`

When a row's type is one the key's type map does not read, the server MUST leave its agreement out of `GET /connectors/{id}/agreements`.

**Tests:** `compliance/connector-state.test.ts › leaves a row the key no longer reads out of its reads and its clears`.

### `connectors/list-agreements-short-page`

When a page of agreements holds rows the key's type map does not read, the server MUST answer the page without them and with a `next_cursor` that reaches the rest, so the page can be short.

**Reason:** the page is cut before the rows are left out, so a cursor never skips a row the key can read.

**Tests:** `compliance/connector-bounds.test.ts › answers a short page with a cursor still to follow, over rows the key no longer reads`.

### `connectors/agreement-unreadable-kept`

When a key's type map is widened to read a type again, the server MUST answer the agreements it kept for rows of that type.

**Tests:** `compliance/connector-state.test.ts › leaves a row the key no longer reads out of its reads and its clears`.

## The fence

`PUT /connectors/{id}/state` and `POST /connectors/{id}/agreements` are written only by the process that holds the registration.

### `connectors/fence-refused`

If a process that holds no live hold on the registration sends `PUT /connectors/{id}/state` or `POST /connectors/{id}/agreements`, whether no process holds it, another does, or its own hold lapsed, then the server MUST answer `409 connector_held`.

**Tests:** `compliance/connector-state.test.ts › fences the state and the agreements to the process that holds the registration`, `› lets another process take a hold that lapsed, and takes its writes once it holds it`, `› refuses a write from a process whose hold lapsed, whether its successor released the hold or let it lapse`.

### `connectors/fence-writes-nothing`

If the server refuses a write with `409 connector_held`, then the server MUST NOT write the state document or any agreement of it.

**Tests:** `compliance/connector-state.test.ts › fences the state and the agreements to the process that holds the registration`, `› lets another process take a hold that lapsed, and takes its writes once it holds it`, `› refuses a write from a process whose hold lapsed, whether its successor released the hold or let it lapse`.

### `connectors/fence-expires-at`

If the server refuses a write with `409 connector_held` while another process holds a live hold, then the server MUST carry that hold's `expires_at` in `details.expires_at`.

**Tests:** `compliance/connector-state.test.ts › fences the state and the agreements to the process that holds the registration`, `› lets another process take a hold that lapsed, and takes its writes once it holds it`, `› refuses a write from a process whose hold lapsed, whether its successor released the hold or let it lapse`.

### `connectors/fence-no-expires-at`

If the server refuses a write with `409 connector_held` while no process holds a live hold, then the server MUST NOT carry `details.expires_at`.

**Tests:** `compliance/connector-state.test.ts › fences the state and the agreements to the process that holds the registration`, `› lets another process take a hold that lapsed, and takes its writes once it holds it`, `› refuses a write from a process whose hold lapsed, whether its successor released the hold or let it lapse`.

## The order of checks

Where one request meets two refusals, each rule below names the refusal the request is told first.

### `connectors/order-cap-before-credential`

If a request to an operation under `/connectors` carries a body over the cap its operation takes and carries no credential, then the server MUST answer `413 request_too_large`.

**Reason:** the server reads the size of a body before it reads who sent it.

**Tests:** `compliance/connector-check-order.test.ts › answers a body nested too deep 400 before a missing credential's 401, and a body over the cap 413`.

### `connectors/order-depth-before-credential`

If a request to an operation under `/connectors` carries a JSON body nested more than 64 levels and carries no credential, then the server MUST answer `400 validation_error`, as `items/json-depth` says of the depth.

**Tests:** `compliance/connector-check-order.test.ts › answers a body nested too deep 400 before a missing credential's 401, and a body over the cap 413`.

### `connectors/order-credential-before-body`

If a request to an operation under `/connectors` carries no credential and a body or query the operation would refuse for anything but the body's size or nesting, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/connector-check-order.test.ts › answers a missing credential 401 before a body the door would refuse`, `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`.

### `connectors/order-operator-before-body`

If the operator key sends `POST /connectors` with a body the operation would refuse, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connector-check-order.test.ts › answers the operator key 403 before a registration body it would be refused for`, `compliance/key-management.test.ts › refuses a key that may not use a door 403 before it reads the request`.

### `connectors/order-body-before-registration`

If a request to an operation under `/connectors/{id}` has a body field or a query parameter that is missing or does not fit the type, format, length, count or values the operation declares for it, then the server MUST answer `400`, whether the id names no registration or the registration of another key.

**Reason:** the declared fields are checked before the server looks for the registration, so `validation_error` and `missing_required_field` come before `connector_not_found` and `forbidden` for them.

**Tests:** `compliance/connector-check-order.test.ts › answers a request the door refuses 400 before the registration's 404 and the key's 403`.

### `connectors/order-registration-before-key`

If a key that an operation under `/connectors/{id}` refuses `403 forbidden` on an existing registration sends it a request whose body and query fit the operation's declaration and that names an id no registration carries, then the server MUST answer `404 connector_not_found`.

**Tests:** `compliance/connector-check-order.test.ts › answers a registration that is not there 404 before the key's 403, on every door the key reaches`.

### `connectors/order-key-before-stray-field`

If a key that an operation under `/connectors/{id}` refuses `403 forbidden` sends it a body whose declared fields fit the declaration and that carries a top-level field the operation does not declare, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connector-check-order.test.ts › answers the key's 403 and the registration's 404 before a field the door does not declare`.

### `connectors/order-registration-before-stray-field`

If a key sends a request to an operation under `/connectors/{id}` that names an id no registration carries, with a body whose declared fields fit the declaration and that carries a top-level field the operation does not declare, then the server MUST answer `404 connector_not_found`.

**Tests:** `compliance/connector-check-order.test.ts › answers the key's 403 and the registration's 404 before a field the door does not declare`.

### `connectors/order-stray-field-before-fence`

If a process that holds no live hold sends `PUT /connectors/{id}/state` or `POST /connectors/{id}/agreements` with a top-level body field the operation does not declare, then the server MUST answer `400 validation_error` and not `409 connector_held`.

**Tests:** `compliance/connector-check-order.test.ts › answers a field the door does not declare 400 before the fence's 409`.

### `connectors/order-body-before-fence`

If a process that holds no live hold sends `PUT /connectors/{id}/state` with a state of more than 512 KiB, or `POST /connectors/{id}/agreements` with a batch that names a row twice or holds a record of more than 16 KiB, then the server MUST answer `400 validation_error` and not `409 connector_held`.

**Tests:** `compliance/connector-check-order.test.ts › answers a state or a batch the door refuses 400 before the fence's 409`.
