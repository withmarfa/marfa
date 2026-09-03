# infra/digitalocean

Deployment shape for running hosted Marfa on a plain Linux box: Docker
Compose, Caddy for TLS, a managed Postgres alongside (production) or a
Postgres container (staging). The shape is committed; operator values are
not — every deployment-specific value arrives through env files that stay
on the box.

This directory is operator tooling, like `.github/` — nothing in the
product's build or startup path may depend on it. A self-hoster's
deployment is `docker-compose.yml` at the repository root; these files are
the hosted deployment's equivalent, deliberately running the same image.

## Files

- `compose.production.yml` — Caddy + the server (+ the worker, behind the
  `split` profile) against an external managed Postgres.
- `compose.staging.yml` — the same plus a Postgres container, making
  staging an exact copy of the self-host deployment.
- `Caddyfile` — TLS termination and the reverse proxy, streaming-safe for
  SSE. The hostname arrives via `MARFA_API_HOSTNAME`, never in git.
- `env.example` — compose-level interpolation values (image reference,
  hostname). Copy to `.env` beside the compose file on the box.
- `server.env.example` — the server's runtime environment. Copy to
  `server.env` on the box, root-owned, mode 0600. The authoritative env
  reference is the repository root `AGENTS.md`; this example carries only
  the deployment-shape choices and their reasoning.

## First deploy, in outline

1. Copy `env.example` → `.env` and `server.env.example` → `server.env`;
   fill both. `chmod 600 server.env`.
2. Production only: fetch the managed database's CA onto the box —
   `doctl databases get-ca <cluster-id> --no-header > /opt/marfa/do-pg-ca.crt`
   — and set `NODE_EXTRA_CA_CERTS=/app/do-pg-ca.crt` in `server.env`.
   The cluster's certificate chains to DigitalOcean's private per-project
   CA, which no default trust store carries; without this the boot fails
   with `SELF_SIGNED_CERT_IN_CHAIN`.
3. Log the box's Docker into the image registry.
4. `docker compose -f compose.<env>.yml pull`
5. `docker compose -f compose.<env>.yml run --rm migrate`
6. `docker compose -f compose.<env>.yml up -d`
7. `curl -fsS https://<hostname>/health` and check the reported SHA.

Migrations always run from the box (step 5): the production database
accepts connections only from inside its private network, which is the
point of the private network.

## The connection budget

The smallest managed-Postgres tier allows 22 usable backend connections,
and nothing here may assume more. Each process runs several pools rather
than one: a main pool capped by `MARFA_DB_POOL_SIZE`, the streaming/job
pool it derives, the reactive-run drainer's single connection, a
single-connection pool for the Connection lifecycle lock, pg-boss's own
pool, and on the web role a small client for the consent lock. The
compose files set the main pool to 3 on the web container and 2 on the
worker, not the built-in default of 10, precisely so the two processes
fit.

**The sum now lands exactly on the tier's limit at worst case**, so there
is no headroom left to promise. Anything that opens a connection during a
deploy is therefore the case to watch, the one-shot migrate step
included: it runs against the full running stack. Before raising any pool
size or adding a process or a pool, redo the sum against the tier's limit
and raise the tier if it does not fit. The env example carries the
current arithmetic and the reasoning for why the worst case is not
reached in practice.
