# Deployment

## Infrastructure

The API depends on two external services:

| Service | Version | Default port |
|---|---|---|
| PostgreSQL | 16 Alpine | 5432 |
| Redis | 7 Alpine | 6379 |

For local development and testing, use the provided Docker Compose file:

```bash
docker compose -f stack.testing.yml up -d
```

Redis is used for both response caching and **BullMQ job queues**. Off-ramp execution jobs are persisted in Redis and survive restarts.

## Environment Variables

Copy `.env.example` to `.env` and fill in values.

### Required

| Variable | Description |
|---|---|
| `NODE_ENV` | `development`, `production`, or `test` |
| `PORT` | HTTP port (default `3030`) |
| `JWT_SECRET` | Signing secret for wallet sign-in JWTs (≥ 32 chars) |
| `ENCRYPTION_KEY` | AES-256-GCM key for sensitive data at rest (≥ 32 chars) |
| `BASE_URL` | Public base URL (e.g. `https://api.wrytes.io`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_HOST` | Redis hostname |
| `REDIS_PORT` | Redis port (default `6379`) |
| `REDIS_PASSWORD` | Redis password |

### Optional — Integrations

| Variable | Integration |
|---|---|
| `ALCHEMY_API_KEY` | Alchemy on-chain data + Safe monitoring |
| `WALLET_PRIVATE_KEY` | Managed hot wallet + Safe signer |
| `ONEINCH_API_KEY` | 1inch DEX aggregator |
| `TELEGRAM_BOT_TOKEN` | Telegram bot |
| `TELEGRAM_WEBHOOK_DOMAIN` | Telegram webhook host |
| `TELEGRAM_WEBHOOK_PATH` | Telegram webhook path (default `/telegram/webhook`) |
| `ANTHROPIC_API_KEY` | Claude AI |

### Optional — Kraken (Wrytes AG operator)

| Variable | Description |
|---|---|
| `KRAKEN_PUBLIC_KEY` | Kraken API public key |
| `KRAKEN_PRIVATE_KEY` | Kraken API private key |
| `KRAKEN_ADDRESS_KEY` | Kraken address key |
| `KRAKEN_CHF_WITHDRAW_KEY` | Key name for Wrytes AG's registered CHF bank account on Kraken |
| `KRAKEN_EUR_WITHDRAW_KEY` | Key name for Wrytes AG's registered EUR bank account on Kraken |

### Optional — Deribit (Wrytes AG operator)

| Variable | Description |
|---|---|
| `DERIBIT_CLIENT_ID` | Deribit client ID |
| `DERIBIT_CLIENT_SECRET` | Deribit client secret |
| `DERIBIT_BASE_URL` | WebSocket URL (default: `wss://www.deribit.com/ws/api/v2`) |

### Optional — Off-Ramp Monitor

| Variable | Description |
|---|---|
| `MONITOR_MODE` | `polling` (dev) or `webhook` (prod). Default: `polling` |
| `MONITOR_POLL_INTERVAL_MS` | Polling interval in milliseconds. Default: `60000` |
| `ALCHEMY_WEBHOOK_SECRET` | Shared secret from Alchemy dashboard. Required when `MONITOR_MODE=webhook` |

### Optional — Logging & Rate Limiting

| Variable | Description |
|---|---|
| `LOG_LEVEL` | Pino log level (default `info`) |
| `LOG_PRETTY` | Pretty-print logs (default `true`, set `false` in prod) |
| `THROTTLE_TTL` | Rate limit window in seconds (default `60`) |
| `THROTTLE_LIMIT` | Max requests per window per user (default `100`) |

## Running in Production

```bash
yarn build
yarn start:prod
```

Set `NODE_ENV=production` and `LOG_PRETTY=false` for structured JSON logging.

## Database Migrations

Run migrations before starting the server:

```bash
yarn prisma migrate deploy
```

This applies all pending migrations non-interactively and is safe to run in CI/CD pipelines.

## Monitor Mode: Webhook (Production)

In production, set `MONITOR_MODE=webhook` and configure an Alchemy Address Activity webhook pointing to:

```
POST https://api.wrytes.io/monitor/webhook
```

Set the `ALCHEMY_WEBHOOK_SECRET` to the signing secret from the Alchemy dashboard. The endpoint verifies the `x-alchemy-signature` HMAC header before processing events.

Register the Safe deposit addresses for all active routes in the Alchemy webhook configuration.

## Health Check

```
GET /health
```

Returns service health status including database and Redis connectivity. Used for container health probes.

## Swagger

Swagger UI is available at `/api/docs` in all environments. In production, consider restricting access to this path at the load balancer level.

## Rate Limiting

Rate limiting is applied globally and scoped per **user** — all API keys belonging to the same user share one request bucket. Unauthenticated endpoints (e.g. `/auth/verify`) fall back to IP-based limiting.

## CORS

CORS is enabled for all origins by default. Restrict this in production by updating `main.ts` with an explicit `origin` allowlist.
