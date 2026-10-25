# Hosting the bot

The bot is one long-running process (`npm start`, `bot/src/main.js`). It
runs Telegram when `TELEGRAM_BOT_TOKEN` is set, and Discord when
`DISCORD_BOT_TOKEN` is set. It polls Telegram and holds a connection to
Discord, and listens on `PORT` for the host's health check (`GET /health`)
and the proposal pages' API. Run **one** copy per bot token. A second copy
polling the same Telegram token makes both fail with `409 Conflict`, so stop
the copy on your computer before starting a hosted one.

## Railway

The repository root has a `Dockerfile` and a `railway.json` (one replica,
restarted if it stops), so Railway builds it as it is.

1. In Railway: **New Project → Deploy from GitHub repo**, and pick
   `replico-labs/protean-near`.
2. In the service's **Variables**, add the values from `bot/.env`:

   | Variable | |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | |
   | `NEAR_NETWORK` | `testnet` |
   | `NEAR_OPERATOR_ACCOUNT_ID`, `NEAR_OPERATOR_PRIVATE_KEY` | |
   | `SPUTNIK_FACTORY_ID`, `DAO_CREATE_DEPOSIT` | `sputnik.protean.testnet`, `0.1` |
   | `KMS_KEY_ID`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | |
   | `CHAT_LINKS_STORE` | `supabase`: the disk is wiped on every deploy, so chat links must live in Supabase |
   | `PROPOSAL_SITE_URL`, `PROPOSAL_LINK_SECRET` | for proposal pages (below); the secret from `openssl rand -hex 32` |

   Optional: `NEAR_RPC_URL`, the governance timings, `NOTIFY_SECONDS`, and
   the Discord variables. Railway sets `PORT` itself.
3. For proposal pages and a health check, give it a public address:
   **Settings → Networking → Generate Domain**. `https://<domain>/health`
   answers `ok`.
4. Deploy. The logs should show `[telegram] Running as @<your bot>`.

Each push to the repository's main branch redeploys the bot. No volume is
needed: everything it keeps lives on NEAR or in Supabase.

## Render

The repository root has a `Dockerfile` and a Render Blueprint,
`render.yaml`, which describes the service: a Docker web service, one
instance, health check on `/health`, redeployed on every push to main.

1. In Render: **New → Blueprint**, and pick the GitHub repository
   (`replico-labs/protean-near`). Render reads `render.yaml`.
2. Render asks for the values the Blueprint leaves out, the ones from
   `bot/.env`:

   | Variable | |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | |
   | `NEAR_OPERATOR_ACCOUNT_ID`, `NEAR_OPERATOR_PRIVATE_KEY` | |
   | `KMS_KEY_ID`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | |
   | `PROPOSAL_SITE_URL` | the website's URL, for proposal pages (below); leave it empty to skip them |

   The Blueprint already sets `NEAR_NETWORK=testnet`,
   `CHAT_LINKS_STORE=supabase` (the disk is wiped on every deploy, so chat
   links must live in Supabase), `SPUTNIK_FACTORY_ID=sputnik.protean.testnet`
   and `DAO_CREATE_DEPOSIT=0.1`, and generates `PROPOSAL_LINK_SECRET`. Add
   anything else from `.env.example` under the service's **Environment**:
   `NEAR_RPC_URL`, the governance timings, `NOTIFY_SECONDS`, the Discord
   variables.
3. **Apply.** The logs should show `[telegram] Running as @<your bot>` and
   `[http] Proposal pages API on port 10000`. Render sets `PORT` itself.

**Use a paid instance** (the Blueprint picks Starter). A free web service
sleeps after 15 minutes without web traffic: Telegram messages don't wake
it, so the bot would stop answering and stop posting notifications.

On a deploy, Railway and Render both start the new copy before stopping
the old one, so for a few seconds both poll Telegram. The new one retries until the old one has
stopped; nothing is lost.

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

1. **The bot's public URL.** On Railway: **Settings → Networking →
   Generate Domain**. A Render web service has one already, at the top of
   its page (`https://protean-near-bot.onrender.com` or similar).
   `https://<that>/health` answers `ok`.
2. **Set the variables:**

   | Variable | |
   | --- | --- |
   | `PROPOSAL_SITE_URL` | the website's URL, the same one the EVM bot uses. The bot builds page links from it and accepts requests only from it. |
   | `PROPOSAL_LINK_SECRET` | a long random secret (`openssl rand -hex 32`; the Render Blueprint generates one); it signs the proposers' edit links |
   | `PROPOSAL_DETAILS_GRACE_HOURS` | optional, default 6 |

   The details are stored in this project's Supabase (`proposal_details`
   and `proposal_detail_versions` in `supabase/schema.sql`), so
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be set too.
3. **Point the website at this bot.** In the website repository,
   `proposal.html` has a `protean-near-api` meta tag. Set it to the bot's
   public URL: pages whose network starts with `near-` read from there.

Leave `PROPOSAL_SITE_URL` or the secret empty and the bot runs as before,
with no page links, no Details buttons and no API.
