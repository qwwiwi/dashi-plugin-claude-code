# dashi-plugin webhook listener

A small Python aiohttp service that accepts swarm webhooks from
[dashi-gbrain](https://github.com/qwwiwi/dashi-gbrain) and spawns a
headless `claude -p` invocation against the configured agent workspace.

It is the inter-agent ingress that complements the agent47-channel plugin
(Telegram ingress). The plugin handles human-driven chat sessions; this
listener handles agent-to-agent task delivery.

## Why it exists

The agent47-channel plugin has no inbox-poll loop. When another agent
publishes a swarm delivery for this agent, the gbrain worker calls the
webhook below, which:

1. verifies the Bearer token
2. enriches the payload from `list_my_pending` if the swarm worker sent
   a degraded (empty) retry (the v6.3 hot-patch)
3. sends a Telegram pre-ack to the owner (optional, opt-in)
4. spawns `claude -p` in the agent workspace with a structured prompt
   that tells Claude how to pick up and complete the task

## Endpoints

| Method | Path             | Notes                                          |
| ------ | ---------------- | ---------------------------------------------- |
| POST   | `/hooks/agent`   | Bearer-auth, JSON body. Returns `accepted` or `empty_inbox`. |
| GET    | `/healthz`       | Static health probe.                           |

## Configuration

All knobs come from the environment. Defaults match a single-agent
single-host install; override anything that is host-specific.

| Env var                       | Default                                    | Required | Notes                                                                |
| ----------------------------- | ------------------------------------------ | -------- | -------------------------------------------------------------------- |
| `WEBHOOK_PORT`                | `8094`                                     | no       | TCP port to bind.                                                    |
| `WEBHOOK_BIND_HOST`           | `127.0.0.1`                                | no       | Loopback by default — flip to `0.0.0.0` only behind a TLS reverse proxy with IP allowlisting. |
| `WEBHOOK_BEARER_FILE`         | `/etc/dashi-plugin/webhook.token`          | yes      | File with the shared Bearer (one line, no trailing newline).         |
| `WEBHOOK_AGENT_NAME`          | _(no default — required)_                  | yes      | Logical agent name. Embedded into the spawn prompt.                  |
| `WEBHOOK_AGENT_WORKSPACE`     | `$HOME/.claude`                            | yes      | CWD passed to `claude -p`. Must contain `CLAUDE.md`.                 |
| `CLAUDE_BIN`                  | `/usr/local/bin/claude`                    | no       | Path to the Claude Code binary.                                      |
| `WEBHOOK_LOG_DIR`             | `/var/log/dashi-plugin-webhook`            | no       | Where per-invocation stdout/stderr lands.                            |
| `INVOCATION_TIMEOUT_SEC`      | `1800`                                     | no       | Hard kill ceiling for a spawned Claude.                              |
| `WEBHOOK_GBRAIN_TOKEN_FILE`   | `$HOME/.secrets/dashi-gbrain.token`        | conditional | gbrain swarm token. Required only if `WEBHOOK_GBRAIN_SWARM_URL` is set. |
| `WEBHOOK_GBRAIN_SWARM_URL`    | _(unset — enrichment disabled)_            | no       | JSON-RPC endpoint of **your own** swarm MCP (see «Bring-your-own swarm endpoint» below). Leave empty to disable the v6.3 enrichment fallback. |
| `WEBHOOK_OWNER_CHAT_ID`       | _(unset — feature off)_                    | no       | Telegram chat id that receives pre-ack pings. Empty → notification disabled. |
| `WEBHOOK_TG_BOT_TOKEN_FILE`   | `$HOME/.secrets/telegram-bot-token`        | conditional | Required only if `WEBHOOK_OWNER_CHAT_ID` is set.                  |
| `WEBHOOK_NOTIFY_TTL_SEC`      | `300`                                      | no       | Dedup window for repeated owner pings on the same task.              |

## Install

This repo ships the listener as source. A typical install on Linux:

```bash
sudo mkdir -p /opt/dashi-plugin-webhook /etc/dashi-plugin /var/log/dashi-plugin-webhook
sudo cp webhook-listener/listener.py /opt/dashi-plugin-webhook/

# Write the Bearer token without leaking it into shell history:
sudo install -m 0600 -o root -g root /dev/null /etc/dashi-plugin/webhook.token
sudoedit /etc/dashi-plugin/webhook.token   # paste the secret, save, exit

python3 -m venv /opt/dashi-plugin-webhook/.venv
/opt/dashi-plugin-webhook/.venv/bin/pip install -r webhook-listener/requirements.txt

sudo cp examples/webhook-listener.service.example \
  /etc/systemd/system/dashi-plugin-webhook.service
# edit /etc/systemd/system/dashi-plugin-webhook.service to set User= and EnvironmentFile=
sudo cp examples/webhook-listener.env.example /etc/dashi-plugin/webhook.env
# edit /etc/dashi-plugin/webhook.env to point to your workspace + tokens
sudo systemctl daemon-reload
sudo systemctl enable --now dashi-plugin-webhook
```

## Bring-your-own swarm endpoint

The v6.3 enrichment fallback expects `WEBHOOK_GBRAIN_SWARM_URL` to point at
**your own** [dashi-gbrain](https://github.com/qwwiwi/dashi-gbrain) instance.
This repo intentionally ships no default — you stand up your own swarm
coordinator and expose it over HTTPS. Two common patterns:

1. **Cloudflare Tunnel** (no public IP, no inbound firewall rule):
   - Run gbrain on your own host (LAN, Tailscale, anywhere reachable from
     itself). Bind the MCP servers to `127.0.0.1:<port>`.
   - Install `cloudflared`, run `cloudflared tunnel login`, then
     `cloudflared tunnel create <name>`.
   - Add an `ingress` mapping `mcp.<your-domain>` → `http://127.0.0.1:<port>`
     in `~/.cloudflared/config.yml` and route the tunnel:
     `cloudflared tunnel route dns <name> mcp.<your-domain>`.
   - Start the tunnel via systemd unit (`cloudflared service install`).
   - Set `WEBHOOK_GBRAIN_SWARM_URL=https://mcp.<your-domain>/swarm/mcp`.

2. **Tailscale + caddy/nginx**: terminate TLS on a host inside the tailnet
   and reach it via the MagicDNS name. Same env shape — point
   `WEBHOOK_GBRAIN_SWARM_URL` at your tailnet hostname.

Either way: the URL you set in `WEBHOOK_GBRAIN_SWARM_URL` is yours, never
a third-party endpoint. The listener also redacts Bearer tokens from log
records so the token does not surface in journal output.

## Security

- The listener fails to start if the Bearer file is missing — no silent
  open mode.
- All log records pass through a redacting formatter that masks Bearer
  tokens, `sk-...` strings, and `password=...` query fragments. If you
  add new secret-bearing log lines, extend `_TOXIC` accordingly.
- Default bind is `127.0.0.1`. For network-facing deploys, terminate
  TLS upstream and allowlist the gbrain swarm worker; the bare process
  trusts only the Bearer header for AuthZ.
- `_notify_owner` `parse_mode=HTML` interpolation goes through
  `html.escape`, so a hostile `from_agent` / `task_id` / `title` cannot
  break the Telegram message or inject markup.
- `--dangerously-skip-permissions` is passed to `claude -p`. The
  spawned agent runs with full permissions inside the configured
  workspace. Keep `WEBHOOK_AGENT_WORKSPACE` confined to a directory
  whose contents you trust.
- The subprocess environment is allowlisted (`HOME`, `PATH`, `USER`,
  `LANG`, `LC_*`, `TERM`, `TZ`, plus `CLAUDE_*` / `ANTHROPIC_*`
  prefixes). `WEBHOOK_*` listener-config vars and any local secret-file
  paths set in the service environment do not propagate to Claude.
- `task_id` is sanitized (`[A-Za-z0-9_.:-]{,64}`) before reaching the
  spawn prompt and the per-invocation log filename, so a payload field
  cannot path-traverse the log directory or break prompt structure.
- The `/healthz` endpoint returns a constant `{"status": "ok"}`; it does
  not echo any server-side configuration even if reachable from the
  network.
