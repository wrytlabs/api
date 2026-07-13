# Getting Started

## Prerequisites

- Node.js 20+
- Docker (for Postgres + Redis)
- An Alchemy API key (for on-chain features)

## 1. Clone and install

```bash
git clone <repo>
cd wrytes-api
yarn install
```

## 2. Start infrastructure

```bash
docker compose -f stack.testing.yml up -d
```

This starts:
- PostgreSQL 16 on `localhost:5432` (db: `wrytes`, user/pass: `postgres`)
- Redis 7 on `localhost:6379` (password: `redis`)

## 3. Configure environment

```bash
cp .env.example .env
```

Minimum required variables:

| Variable | Description |
|---|---|
| `JWT_SECRET` | Signing secret for wallet sign-in JWTs (≥ 32 chars) |
| `ENCRYPTION_KEY` | AES-256-GCM key for sensitive data at rest (≥ 32 chars) |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis connection |

Optional (enables specific features):

| Variable | Feature |
|---|---|
| `ALCHEMY_API_KEY` | On-chain data + Safe monitoring |
| `WALLET_PRIVATE_KEY` | Safe deployment and ERC-20 transfers |
| `KRAKEN_*` | Kraken operator account |
| `KRAKEN_CHF_WITHDRAW_KEY` | Fiat withdrawal to Wrytes AG CHF bank |
| `KRAKEN_EUR_WITHDRAW_KEY` | Fiat withdrawal to Wrytes AG EUR bank |
| `ONEINCH_API_KEY` | 1inch swaps |
| `TELEGRAM_BOT_TOKEN` | Telegram notifications |
| `ANTHROPIC_API_KEY` | AI features |
| `MONITOR_MODE` | `polling` (dev) or `webhook` (prod), default `polling` |
| `MONITOR_POLL_INTERVAL_MS` | Polling interval in ms, default `60000` |
| `ALCHEMY_WEBHOOK_SECRET` | Required when `MONITOR_MODE=webhook` |

See [`.env.example`](../.env.example) for the full list.

## 4. Run migrations

```bash
yarn prisma migrate deploy
```

## 5. Start the server

```bash
# development (watch mode)
yarn start:dev

# production
yarn build && yarn start:prod
```

The API is available at `http://localhost:3030` by default.

Swagger UI: `http://localhost:3030/api/docs`

## 6. Get an API key

API keys are issued via magic links. You need a user record first — typically created via the Telegram bot or admin scripts in `prisma/scripts/`.

Once you have a magic link token:

```bash
GET /auth/verify?token=<token>
# Returns: { key: "rw_prod_<keyId>.<secret>" }
```

Use that key in all subsequent requests:

```
X-API-Key: rw_prod_<keyId>.<secret>
```

See [authentication.md](./authentication.md) for the full auth flow.

## 7. Onboard a member (operator steps)

1. Create user and issue magic link (admin script or Telegram bot)
2. Grant scopes: `USER`, `OFFRAMP`, `SAFE`
3. Member fills in their profile (`PUT /member/profile`)
4. Operator verifies profile (`POST /member/profile/:userId/verify`)
5. Member adds a bank account (`POST /bank-accounts`)
6. Member creates an off-ramp route (`POST /offramp/routes`) → receives a deposit address
7. Member sends crypto to the deposit address — the system handles the rest

See [offramp.md](./offramp.md) for the full off-ramp flow.
