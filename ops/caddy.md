# Caddy

Caddy is used as a reverse proxy for services that need TLS or a stable port.

## Installation (macOS)

```bash
brew install caddy
```

## Caddyfile

Default location: `/opt/homebrew/etc/Caddyfile` (Apple Silicon) or `/usr/local/etc/Caddyfile`.

Example configuration for Myme services:

```
# Uptime Kuma — monitoring dashboard
:8610 {
    reverse_proxy localhost:3001
}
```

## Managing Caddy

```bash
# Start as a service
brew services start caddy

# Reload after config changes
caddy reload --config /opt/homebrew/etc/Caddyfile

# Check config syntax
caddy validate --config /opt/homebrew/etc/Caddyfile

# View logs
tail -f /opt/homebrew/var/log/caddy.log
```

## TLS

Caddy automatically provisions TLS certificates when using domain names. For Tailscale-only access (IP-based), TLS is not needed — Tailscale provides WireGuard encryption in transit.

If exposing Myme beyond Tailscale (e.g., for a hosted offering), add a domain-based site block:

```
myme.example.com {
    reverse_proxy localhost:8602
}
```

Caddy will automatically obtain and renew a Let's Encrypt certificate.

## HSTS

The Myme server supports `ENABLE_HSTS=true` to set the `Strict-Transport-Security` header. Only enable this when the server is behind TLS termination (Caddy with a domain, or a cloud load balancer).
