# Hosting the bot

The bot is one long-running process (`npm start`, `bot/src/main.js`). It
runs Telegram when `TELEGRAM_BOT_TOKEN` is set, and Discord when
`DISCORD_BOT_TOKEN` is set. The chat side needs no inbound port: it polls
Telegram and holds a connection to Discord. Only proposal pages (below)
need a public URL. Run **one** copy per bot token. A second copy
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

The bot posts in each linked chat when a proposal is made elsewhere
(another chat, or straight on chain), when voting ends, when a passed
proposal can be executed, when its execution window has an hour left, and
when it expires. It also posts each model's own steps: a challenge,
positions or markets opening, and a Sowellian outcome being measured,
proposed, disputed and resolved. Each notice carries the proposal's
buttons for that moment. It checks every
`NOTIFY_SECONDS` (default 60; `0` turns notifications off). What it has
already announced is kept with the chat's link, so a restart doesn't
repeat anything.

## Proposal pages

Each proposal gets a page on the Protean website, at
`/p/near-testnet/<orbit>/<id>`. The website is static: it reads each page's
data from this bot's API, `GET /api/proposals/...`, and the proposer's form
`POST`s there. To turn the pages on:

1. **Give the bot a public URL.** On Railway: the service's **Settings →
   Networking → Generate Domain**. Railway sets `PORT` itself. The bot
   answers `GET /health` with `ok`.
2. **Set the variables:**

   | Variable | |
   | --- | --- |
   | `PROPOSAL_SITE_URL` | the website's URL, the same one the EVM bot uses. The bot builds page links from it and accepts requests only from it. |
   | `PROPOSAL_LINK_SECRET` | a long random secret (`openssl rand -hex 32`); it signs the proposers' edit links |
   | `PROPOSAL_DETAILS_GRACE_HOURS` | optional, default 6 |

   The details are stored in this project's Supabase (`proposal_details`
   and `proposal_detail_versions` in `supabase/schema.sql`), so
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be set too.
3. **Point the website at this bot.** In the website repository,
   `proposal.html` has a `protean-near-api` meta tag. Set it to the bot's
   public URL: pages whose network starts with `near-` read from there.

Leave `PROPOSAL_SITE_URL` or the secret empty and the bot runs as before,
with no page links, no Details buttons and no API.
