# Protean on NEAR

Protean turns a group chat into a DAO. This repository is Protean's NEAR
version: the **Orbits** contracts, and the Protean bot for Telegram and
Discord.

**Orbits** is a modular NEAR governance framework that provides
interchangeable governance modules for Sputnik DAO, for building and evolving
onchain organizations. Communities can swap their governance model by
proposal without moving their treasury.

> Status: contracts and bot are tested locally and run end to end on a
> local NEAR node (docs/sandbox.md). They haven't run on testnet yet.

## How it works

- **Core:** an unmodified Sputnik DAO, created through the official factory.
  It holds the treasury and executes proposals.
- **Orbit:** the governance module, one contract per model. It's the core's only member: people
  propose and decide in the orbit under its model, and when a proposal passes
  the orbit's single vote executes it on the core.
- **Staking:** one staking contract per DAO, owned by the core. Every orbit
  reads stake from it by snapshot, so members keep their stake when the DAO
  switches models.
- **Switch:** one proposal hands the core to a new orbit running another
  model. The treasury and stakes never move.

| Model | How it decides |
| --- | --- |
| `board` | Named members approve directly on the DAO by majority (Sputnik's own multisig, no orbit) |
| `tokenWeighted` | One staked token, one vote; quorum and approval thresholds, timelock |
| `quadratic` | Voting weight is the square root of stake |
| `liquid` | Vote directly, or delegate; delegated weight follows the chain to whoever voted |
| `optimistic` | Passes after a challenge window unless someone posts a bond, which starts a vote |
| `conviction` | Back one proposal at a time with locked stake; conviction builds over time |
| `delegate` | Stakers elect a council for a term and can recall members |
| `sortition` | A council drawn at random from stakers who opt in |
| `sowellian` | Approve a proposal with its success criteria, bet YES/NO on the outcome, resolve it after measuring (oracle, or a bonded resolver open to dispute) |
| `decisionMarkets` | Each proposal gets pass and fail markets; the one pricing the token higher over the window decides |

The rules follow Protean's EVM contracts
([Spaces](https://github.com/replico-labs/Spaces)). Because the core is plain
Sputnik, a Protean DAO also works in Sputnik tools such as Trezu. Design:
[docs/SPEC.md](docs/SPEC.md).

## Repository layout

```
orbits/                    Rust contracts (Cargo workspace)
  modules/                 the nine governance modules, one contract each
  orbit/                   the engine the modules are built from (a feature per model)
  orbit-staking/           a DAO's staking contract: stake history, locks
  orbit-common/            which proposals may reach the core; the calls to it
  governance-token/        fixed-supply NEP-141 token
  core-tests/              checks against the real Sputnik contract
  deployments/             published code hashes, per network
bot/                       Telegram and Discord bot (Node)
  src/platforms/commands/  the commands, shared by both platforms
  src/near/                NEAR: accounts, orbit, staking, Sputnik, deployment
  scripts/                 publish the contracts; create a DAO from the shell
docs/                      SPEC.md (design), sandbox.md (local node), testnet-check.md
supabase/schema.sql        the bot's database
```

## Try it

### 1. Contract tests (Rust 1.85+)

```bash
cd orbits && cargo test
```

Expect every suite to pass (70 tests). They show, among others, that:

- a Sputnik DAO whose only member is an orbit executes what the orbit passes,
  refuses everyone else, and moves to a new orbit in one proposal;
- each model decides like its Spaces counterpart: quorum and approval,
  square-root weights, delegation chains, challenge bonds, conviction,
  elections and recalls, random draws, outcome bets with disputes and
  adjudication, and pass/fail markets decided by time-weighted price;
- a passed proposal reaches the DAO exactly once, and only after its
  timelock;
- stake is read by snapshot, and locks block unstaking;
- every proposal, model setting and DAO policy the bot creates works on the
  contracts (`bot/test/fixtures`).

### 2. Bot tests (Node 20+)

```bash
cd bot && npm install && npm test
```

Expect `pass 48`. The commands run against a fake chain.

### 3. Run it on a local NEAR node

A sandbox node runs everything against real contracts, for free:
`./bot/scripts/sandbox-prepare.sh` gets the node and every contract, then
`sandbox-flow.js` runs a DAO's life and the integrations, and
`sandbox-models.js` runs each governance model's own mechanics (delegation,
challenges, elections and recalls, random councils, bets and adjudication,
decision markets). See [docs/sandbox.md](docs/sandbox.md).

### 4. Run it on testnet

You need a funded testnet operator account, a Telegram or Discord bot token,
a Supabase project (run `supabase/schema.sql`) and an AWS KMS key.
Publishing all eleven contracts costs about 255 NEAR, once per network
(global contracts cost 10× normal storage). You can start with staking,
the token and the modules you need, about 23-28 NEAR each, and add the
rest later. Each DAO after that costs well under 1 NEAR.

```bash
# Build the contracts (needs cargo-near)
cd orbits
for c in modules/* orbit-staking governance-token; do (cd $c && cargo near build non-reproducible-wasm); done

# Configure, then publish the contracts once as global contracts
cd ../bot
cp ../.env.example .env        # fill it in
node scripts/publish-contracts.js        # shows the cost
node scripts/publish-contracts.js --yes  # publishes all
node scripts/publish-contracts.js tokenWeighted quadratic --yes  # or only some models

# Protean's own Sputnik factory (Sputnik's code, unmodified, shared as a global
# contract): a DAO then costs ~0.6 NEAR instead of ~6.6 with sputnikv2.testnet
./scripts/build-sputnik.sh
node scripts/deploy-factory.js           # shows the cost (~49 NEAR, once)
node scripts/deploy-factory.js --yes     # then set SPUTNIK_FACTORY_ID and DAO_CREATE_DEPOSIT=0.1

npm run telegram     # or: npm run discord
```

In a Telegram group with the bot (as a group admin):

| Do | See |
| --- | --- |
| `/createdao ark ARK 1000000` | 🏛 ark is live, with tokenWeighted governance; you hold 1,000,000 ARK |
| `/send 1000 ARK <a member's account>` (they get theirs from `/wallet`) | ✅ Sent |
| Each member: `/stake 1000` | ✅ Staked |
| `/pay 1 NEAR me test payout` | 📝 New proposal #0, with For / Against / Abstain buttons |
| Members press **For** | 🗳 Voted for |
| After voting ends: **Execute** | ▶️ #0 was executed on the DAO |
| `/treasury` | The DAO's NEAR balance, 1 NEAR lower |
| `/switchmodel quadratic`, vote, execute | 🔀 The DAO now runs quadratic governance. Same treasury, same stakes |

Voting periods default to an hour so a lifecycle fits in a demo; see
`.env.example` to lengthen them.

## Commands

| | |
| --- | --- |
| Setup | `/createdao <name> <SYMBOL> <supply> [model] [members...]` · `/link <dao> [orbit]` · `/unlink` · `/switchmodel <model> [members...]` |
| Wallet | `/wallet` · `/stake` · `/unstake` · `/send <amount> <NEAR\|token> <account>` · `/tip <amount>` (as a reply to someone's message; or name an account) |
| The DAO | `/dao` · `/treasury` · `/proposals` · `/proposal <id>` · `/council` |
| Proposing | `/pay <amount> <NEAR\|token> <account> <description>` · `/signal <text>` |
| NEAR Intents | `/buy <amount> <from> <to>[@chain] [slippage%]` · `/paychain <amount> <token>@<chain> <address> <description>` · `/intentsstatus <id>` · `/intentswithdraw <amount> <token>` |
| EVM (Chain Signatures) | `/evm` · `/aave supply\|withdraw <amount\|all>` (Aave on Base) |
| Hyperliquid | `/hyperliquid` · `/hlagent <address> [name]` · `/hlrevoke [name]` · `/hlsend <amount> <address>` |
| Treasury | `/swap <amount> <from> <to> [slippage%]` (on Rhea) · `/liquidstake <amount> [linear\|metapool\|nearx]` · `/liquidunstake <amount> [provider]` · `/liquidwithdraw [provider]` |
| Deciding | `/vote <id> for\|against\|abstain` · `/execute <id>` · `/cancel <id>` |
| Optimistic | `/challenge <id>` · `/resolvechallenge <id>` |
| Liquid | `/delegate <account>` · `/undelegate` · `/resolve <id> [delegator]` |
| Conviction | `/support <id>` · `/withdrawsupport` · `/queue <id>` |
| Delegate | `/startelection` · `/declarecandidacy` · `/voteinelection <candidates...>` · `/finalizeelection` · `/recall <member>` · `/voterecall <id> <choice>` · `/finalizerecall <id>` |
| Sortition | `/registereligible` · `/withdraweligibility` · `/draw` |
| Sowellian | `/position <id> yes\|no <amount>` · `/proposeresolution <id> success\|failure` · `/dispute <id>` · `/adjudicate <id> <outcome>` · `/finalizeresolution <id>` · `/claimposition <id>` · `/forfeitbond <id>` |
| Decision markets | `/seed <id> <tokens> <NEAR>` · `/split <id> <amount> <NEAR\|token>` · `/trade <id> pass\|fail <amount> <NEAR\|token>` · `/merge` · `/redeem <id>` · `/reclaimliquidity <id>` |

`/help` and Telegram's "/" command menu show only the commands for the
chat's model; a chat without a DAO sees just `/help`, `/createdao`,
`/link`, `/wallet` and `/send`.

The treasury commands propose putting DAO funds to work on NEAR, voted on
like any other proposal: swaps on Rhea (formerly Ref Finance), with a
minimum output so a swap reverts rather than fill at a worse price, and
liquid staking with LiNEAR, Meta Pool or Stader (NearX). `/treasury` lists what the DAO
holds, including swapped tokens and staked NEAR.

Through [NEAR Intents](https://docs.near-intents.org/) (mainnet), a DAO can
buy any token it lists (`/buy 100 USDC BTC`) and pay an exact amount to an
address on 30+ chains (`/paychain 500 USDC@sol <address> March design
work`). The bot gets a live 1Click quote and proposes depositing into it; it
only proposes when the quote lasts longer than the proposal can still
execute, because depositing into an expired quote can lose the funds. If
the price moves past the slippage, the deposit is refunded to the DAO's own
NEAR Intents account, and `/intentswithdraw` brings it back. Bought assets
that live on other chains (BTC, ETH...) stay in that account.

With NEAR [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures),
each DAO also has its own address on EVM chains, derived from its NEAR
account, which only its proposals can sign for (`/evm` shows it). `/aave
supply 100` proposes the Base transactions (approve, then supply to Aave);
the proposal carries them unsigned in its description, so anyone can check
what the DAO is signing, and asks NEAR's signing network to sign them. When
it executes, the bot takes the signatures from the execution, checks each
recovers to the DAO's address, and sends the transactions. Fund the address
through NEAR Intents: `/paychain 100 USDC@base dao <description>`.

The same address is the DAO's Hyperliquid account; NEAR Intents funds it
directly (`/paychain 500 USDC@hypercore dao <description>`). Voting on every
order would be too slow for perps, so the DAO appoints a trading agent by
proposal (`/hlagent <address>`): a trader, a bot or an AI agent that can
place and cancel orders for the DAO's account but can't withdraw.
`/hlrevoke` replaces it with an address nobody holds, and moving USDC out
(`/hlsend`) takes a proposal. These are Hyperliquid's own signed actions,
signed by the DAO's key; Hyperliquid accepts them for about three days, so
the proposal must execute by then (the proposal says when). The menu updates on its own when a chat
creates, links, unlinks or switches its DAO. Accounts can be written as
`me`.

Each command is defined once in `bot/src/platforms/commands/`, one file
per topic (`setup.js`, `wallet.js`, `dao.js`, `proposing.js`,
`deciding.js`, `council.js`, `markets.js`), and Telegram and Discord both
run them.

## Accounts and keys

Each chat user gets a named NEAR account under the operator, such as
`tg123456.orbits.testnet`, created on first use. Its key is generated by the
bot and stored envelope-encrypted with AWS KMS in Supabase: a custodial model,
as in Protean's EVM bot. The bot's KMS access is limited to the encryption
context `{"app": "protean-near"}`. Contract accounts are created with no
access key and use shared code by hash, so their code can't be changed.

## Built with

- [Sputnik DAO](https://github.com/near-daos/sputnik-dao-contract) (MIT),
  unmodified, as every DAO's core.
- [Rhea Finance](https://rhea.finance/) (formerly Ref Finance) for swaps,
  and [LiNEAR](https://github.com/linear-protocol/LiNEAR),
  [Meta Pool](https://github.com/Narwallets/meta-pool) and
  [Stader NearX](https://github.com/stader-labs/near-liquid-token) for
  liquid staking.
- NEAR global contracts: the nine modules and the staking and token
  contracts are published once by code hash, and every DAO uses them
  without its own copy.
- NEAR named accounts and sub-accounts (`tg123456.orbits.testnet`,
  `tw.ark.orbits.testnet`).
- Protean's EVM contracts and bot ([Spaces](https://github.com/replico-labs/Spaces))
  as the model rules and the chat layer's base.
