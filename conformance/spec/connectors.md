# Connectors

The smallest door a process outside the server needs: it registers with a name and a description under the key it holds, heartbeats, and reports each run with its outcome, and the server lists what registered. No runtime, no supervision, no manifests: a reader decides what a stale heartbeat or a failed run means.

## Registration

1. `POST /connectors` with `{name, description?}` registers the caller's key as a connector and answers `201` with `{id, key_id, name, description, registered_at, updated_at, last_heartbeat_at, last_run}`; `last_heartbeat_at` and `last_run` are `null` until a heartbeat or a run arrives. A name outside 1 to 200 characters, or a description over 2000, answers `400 validation_error`. `compliance/connectors.test.ts › registers the key as a connector and lists it`, `› refuses a name outside the bounds`.
2. One registration per key: the same key registering again updates the name and the description and answers `200` with the same `id`, its `updated_at` moved and its `registered_at` kept. `compliance/connectors.test.ts › registers once per key, updating on repeat`.
3. `GET /connectors` lists every registration to any key, newest first, each with its `key_id`, the key's `source`, its `last_heartbeat_at` and its `last_run`; `GET /connectors/{id}` answers one, and an unknown id `404 connector_not_found`. `compliance/connectors.test.ts › registers the key as a connector and lists it`, `› answers 404 for an unknown connector, where a registered one answers`.
4. `DELETE /connectors/{id}` removes the registration and its runs, to the connector's own key or the operator key; another key is refused `403 forbidden` and the registration stands. `compliance/connectors.test.ts › removes a registration for its own key or the operator, never another`.

## Heartbeats and runs

5. `POST /connectors/{id}/heartbeat` from the connector's own key answers `200 {last_heartbeat_at}` and the listing carries it; another key is refused `403 forbidden` and the stamp does not move. `compliance/connectors.test.ts › takes a heartbeat from the connector's key alone`.
6. `POST /connectors/{id}/runs` with `{outcome, started_at, finished_at, summary?, error?}` from the connector's own key records a run and answers `201` with it; `outcome` is `succeeded` or `failed` and anything else answers `400 validation_error`; `finished_at` before `started_at` answers `400 validation_error`; another key is refused `403 forbidden`. `compliance/connectors.test.ts › records a run from the connector's key and refuses an outcome it does not know`.
7. `GET /connectors/{id}/runs` lists a connector's runs to any key, newest first, `limit` at most 200 and 50 unless given; the listing's `last_run` is the newest. `compliance/connectors.test.ts › lists runs newest first and names the last on the registration`.
8. The server keeps the last 100 runs per connector: the 101st reported drops the oldest. `compliance/connectors.test.ts › keeps the last hundred runs`.
9. A registration and a removal write audit rows (`connector.register`, `connector.delete`); heartbeats and runs do not. `compliance/connectors.test.ts › audits a registration and a removal, not a heartbeat or a run`.
10. `GET /` names `connectors` among its features. `compliance/instance.test.ts › describes itself at the root`.
