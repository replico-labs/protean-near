# Hosting the bot

The bot is one long-running process (`npm start`, `bot/src/main.js`). It
runs Telegram when `TELEGRAM_BOT_TOKEN` is set, and Discord when
`DISCORD_BOT_TOKEN` is set. It needs no inbound port: it polls Telegram and
holds a connection to Discord. Run **one** copy per bot token. A second copy
polling the same Telegram token makes both fail with `409 Conflict`, so stop
the copy on your computer before starting a hosted one.

## Railway

The repository root has a `Dockerfile` and a `railway.json`, so Railway builds it
as it is.

1. In Railway, create a project from the GitHub repository
   (`replico-labs/protean-near`).
2. In the service's **Variables**, add the settings from `.env.example`
   that you use in `bot/.env`, at least:

   | Variable | |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | |
   | `NEAR_NETWORK` | `testnet` |
   | `NEAR_OPERATOR_ACCOUNT_ID`, `NEAR_OPERATOR_PRIVATE_KEY` | |
   | `SPUTNIK_FACTORY_ID`, `DAO_CREATE_DEPOSIT` | `sputnik.protean.testnet`, `0.1` with Protean's factory |
   | `KMS_KEY_ID`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | |
   | `CHAT_LINKS_STORE` | `supabase`: a host's disk is wiped on every deploy, so chat links must live in Supabase |

   Optional: `NEAR_RPC_URL`, the governance timings, `NOTIFY_SECONDS`, and
   the Discord variables.
3. Deploy. The logs should show `[telegram] Running as @<your bot>`.

Each push to the repository's main branch redeploys the bot.

## Any other Docker host

```bash
docker build -t protean-near-bot .
docker run -d --restart unless-stopped --env-file bot/.env protean-near-bot
```

## Notifications

The bot posts in each linked chat when voting on a proposal ends, when a
passed proposal can be executed (with an Execute button), when its
execution window has an hour left, and when it expires. It checks every
`NOTIFY_SECONDS` (default 60; `0` turns notifications off). What it has
already announced is kept with the chat's link, so a restart doesn't
repeat anything.
