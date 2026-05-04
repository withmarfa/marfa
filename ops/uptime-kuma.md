# Uptime Kuma

Health monitoring dashboard for Myme environments. Runs as a Docker container, accessible via Tailscale only.

## Setup

### Docker Compose

Create a `docker-compose.yml` on the server (e.g., `~/Services/uptime-kuma/docker-compose.yml`):

```yaml
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"
    volumes:
      - data:/app/data

volumes:
  data:
```

Start it:

```bash
docker compose up -d
```

### Caddy reverse proxy

Expose on port 8610 via Caddy (see [caddy.md](./caddy.md)):

```
:8610 {
    reverse_proxy localhost:3001
}
```

Restrict access to the Tailscale subnet via firewall rules or Caddy's `remote_ip` matcher.

## Monitor configuration

Add these monitors in the Uptime Kuma UI:

| Name             | Type | URL                            | Interval |
| ---------------- | ---- | ------------------------------ | -------- |
| Myme Staging     | HTTP | `http://localhost:8602/health` | 60s      |
| Myme Conformance | HTTP | `http://localhost:8601/health` | 60s      |

Both should check for HTTP 200 and the response keyword `"ok"`.

## Error webhook integration

The Myme server supports `ERROR_WEBHOOK_URL` for 500 error notifications. You can point this at an Uptime Kuma push monitor:

1. Create a Push monitor in Uptime Kuma
2. Copy the push URL
3. Set `ERROR_WEBHOOK_URL` in the server's launchd plist to that URL

The server debounces notifications to max 1 per error type per minute.
