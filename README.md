# Codex2CC

> Experimental. Use at your own risk.

Use your **Codex subscription as the backend for Claude Code** — one subscription, both sides.

Minimal **Anthropic Messages API** gateway that talks to your local `codex app-server`.

## Install

**Option A — global (recommended)**

```bash
git clone https://github.com/your-org/codex2cc.git
cd codex2cc
npm install -g .
```

Then you can run `codex-gateway` from any directory.

**Option B — use without installing**

From your project: `npx codex2cc start` (and `npx codex-gateway help` when needed).

## Quick start

**1. Start the gateway** from your project directory (so Codex uses it as workdir):

```bash
codex-gateway start
```

If not installed globally: `npx codex2cc start`

**2. Set env and use Claude** (other terminal or IDE):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_API_KEY=dummy
claude --setting-sources local
```

If `~/.claude/settings.json` overrides the URL, run Claude with `--setting-sources local`.

## Options

| Option                | Default           | Description                                                      |
| --------------------- | ----------------- | ---------------------------------------------------------------- |
| `GATEWAY_PORT`        | `8080`            | HTTP port                                                        |
| `CODEX_PATH`          | `codex`           | Codex CLI path                                                   |
| `CODEX_WORKDIR`       | cwd               | Working directory (where you run the gateway)                    |
| `CODEX_SANDBOX`       | `workspace-write` | `read-only`, `workspace-write`, `danger-full-access`, `seatbelt` |
| `DEFAULT_CODEX_MODEL` | `gpt-5.2`         | Fallback Codex model                                             |

More: `AUTO_APPROVE`, `FORCE_STREAM_FALSE`, `AUTO_RESTART`, timeouts, etc. Run `codex-gateway help` (or `npx codex-gateway help`) for CLI flags.

## API

- **POST /v1/messages** — non-streaming.
- **POST /v1/messages/count_tokens**, **GET /v1/models** — minimal compatible responses.

Model mapping: `opus` → `gpt-5.3-codex`; `sonnet` / `haiku` → `gpt-5.2`; others use `DEFAULT_CODEX_MODEL`.

## Health

```bash
curl http://127.0.0.1:8080/healthz
```
