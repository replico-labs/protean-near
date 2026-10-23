# Protean on NEAR

Protean turns a group chat into a DAO. A Telegram or Discord group creates a
DAO with one command, holds a treasury on NEAR, and decides what to do with
it by proposal: pay people, swap and stake its funds, buy tokens on other
chains, supply to Aave on Base, or trade perps on Hyperliquid through an
appointed agent. When the group's needs change, it switches its governance
model by proposal, without moving its treasury.

This repository holds both halves:

- **Orbits**, the NEAR contracts: interchangeable governance modules for
  Sputnik DAO.
- **The Protean bot**, which runs the DAO from the chat.

> Status: the contracts are published on NEAR testnet
> (`orbits/deployments/testnet.json`). Everything runs end to end on a local
> NEAR node (`docs/sandbox.md`): the full flow, every governance model, and
> every integration.

## How it works

### The big picture

```
 Telegram / Discord group
     │  /createdao  /pay  /vote  /execute  /swap  /buy  /aave ...
     ▼
 Protean bot ── signs each action with the member's own NEAR account
     │
     ▼
 Member accounts (tg123456.protean.testnet)
     │ stake                           │ propose, vote
     ▼                                 ▼
 ┌───────────┐   reads stake   ┌──────────────┐  its only member  ┌────────────┐
 │  Staking  │◀────────────────│    Orbit     │──────────────────▶│    Core    │
 │ (per DAO) │   by snapshot   │ (governance  │   adds + approves │ (Sputnik,  │
 └───────────┘                 │   module)    │   what passed     │  treasury) │
       ▲                       └──────────────┘                   └─────┬──────┘
 ┌───────────┐                                                          │ executes
 │   Token   │                                                          ▼
 └───────────┘          Rhea · liquid staking · NEAR Intents · Chain Signatures
                                              │
                                              ▼
                    Other chains: BTC, Solana… · Aave on Base · Hyperliquid
```

### The pieces

| Piece | What it is |
| --- | --- |
| **Core** | An unmodified [Sputnik DAO](https://github.com/near-daos/sputnik-dao-contract). It holds the treasury and executes proposals. Its one governance member is the orbit, so nothing reaches the treasury except what governance passed. |
| **Orbit** | The governance module: one contract per model, nine in all. Members propose and decide in the orbit under its rules; when a proposal passes, the orbit's single vote executes it on the core. |
| **Staking** | One per DAO, owned by the core. Members stake the DAO's token here, and stake is voting weight. Every orbit reads it by snapshot, so stakes survive a model switch. |
| **Token** | The DAO's own fixed-supply token (NEP-141). Whoever creates the DAO receives the whole supply and distributes it. |
| **Factory** | Creates each core. Protean runs its own copy of Sputnik's newer factory (`sputnik.protean.testnet`); the official one works too. |
| **Bot** | Turns chat commands into NEAR transactions, signed by each member's own account. It holds no special power over any DAO. |

### A DAO's accounts

A DAO called `ark`, running token-weighted governance, gets:

| Account | Role |
| --- | --- |
| `ark.sputnik.protean.testnet` | The core and treasury |
| `token.ark.protean.testnet` | The ARK token |
| `staking.ark.protean.testnet` | Stakes and their history |
| `tw.ark.protean.testnet` | The orbit (`tw` token-weighted, `qv` quadratic, `lq` liquid, `op` optimistic, `cv` conviction, `dg` delegate, `st` sortition, `sw` sowellian, `dm` decision markets) |

Each chat member gets an account too: `tg<Telegram user id>.protean.testnet`
(`dc…` on Discord).

None of these contract accounts has an access key, and their code is shared
by hash, as NEAR global contracts. Nobody can change a DAO's contracts,
Protean included.

### Life of a proposal

1. **Propose.** `/pay 1 NEAR <account> design work` asks the orbit to store
   a Sputnik proposal, here a `Transfer`. The orbit checks first that the
   proposal can't break the DAO (see *Safety*).
2. **Decide.** Members vote under the orbit's model. Each member's weight
   is their stake at the moment the proposal was made, so tokens can't be
   moved around to vote twice.
3. **Wait out the timelock.** A passed proposal can't execute straight away,
   which gives members time to see it coming.
4. **Execute.** Anyone runs `/execute`. The orbit adds the proposal to the
   core and approves it with its single vote; Sputnik executes it at once.
   A proposal reaches the core exactly once, and a send that fails partway
   can be retried safely.

A defeated, cancelled or expired proposal never reaches the treasury.

### Switching models

`/switchmodel quadratic` creates a new orbit running the new model and
proposes handing it the core. The proposal goes through the current
model's own rules. If it passes, a single policy change on the core swaps
the old orbit for the new one. Before approving, the old orbit checks that
the new one really belongs to this DAO.

The treasury and the stakes never move. Proposals still open in the old
orbit can't execute after the switch.

### The governance models

| Model | How it decides |
| --- | --- |
| `board` | Named members approve directly on the core by majority (Sputnik's own multisig, no orbit) |
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
([Spaces](https://github.com/replico-labs/Spaces)). Full rules:
[docs/SPEC.md](docs/SPEC.md).

### Putting the treasury to work

Each action below is an ordinary proposal: members vote on it like any other, and nothing moves until it passes.

| | How it works |
| --- | --- |
| **Swaps** (`/swap`) | On [Rhea Finance](https://rhea.finance/). The proposal fixes a minimum output, so a swap reverts rather than fill at a worse price. |
| **Liquid staking** (`/liquidstake`) | With LiNEAR, Meta Pool or Stader (NearX). The DAO holds the liquid token, and unstaking follows each provider's delay. |
| **Buying tokens on other chains** (`/buy`), **paying anyone on 30+ chains** (`/paychain`) | Through [NEAR Intents](https://docs.near-intents.org/). The bot fetches a live quote and proposes depositing into it, but only when the quote outlasts the proposal's execution window: depositing into an expired quote can lose funds. If the price moves past the slippage, the deposit is refunded to the DAO's own NEAR Intents account, and `/intentswithdraw` brings it back. |
| **Aave on Base** (`/aave`) | Supply or withdraw USDC or ETH. Through [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures), each DAO has its own EVM address, which only its proposals can sign for (`/evm`). The proposal carries the unsigned Base transactions in its description, so anyone can check what the DAO is signing. On execution, NEAR's signing network signs them; the bot checks each signature recovers to the DAO's address, then sends them. If sending fails, the signatures stay valid and `/execute` again finishes the job. |
| **Hyperliquid perps** | The same address is the DAO's Hyperliquid account, funded through NEAR Intents (`/paychain 500 USDC@hypercore dao …`). Voting on every order would be too slow, so the DAO appoints a trading agent by proposal (`/hlagent`), which can trade for the DAO but never withdraw. The agent can be an outside address (a trader, an AI agent), or the bot itself (`/hlagent bot`): then the traders the DAO votes in (`/hltraders`) trade from the chat (`/long`, `/short`, `/close`), within limits it also votes on (`/hllimits`: the largest position per market, the highest leverage, which markets). The bot holds that agent's key encrypted with KMS, and checks every order against the rules before signing it. Revoking the agent (`/hlrevoke`) and moving USDC out (`/hlsend`) each take a proposal. |

`/treasury` lists everything the DAO holds: NEAR, its token, swapped
tokens, staked NEAR, and its NEAR Intents balances.

### Accounts, keys and who pays

- **Member accounts are custodial.** The bot creates each member's account
  on first use. It generates the key and stores it encrypted with AWS KMS in
  Supabase, as Protean's EVM bot does, under the encryption context
  `{"app": "protean-near"}`.
- **The operator account (`protean.testnet`) pays the running costs:**
  - creating member accounts;
  - gas for every action;
  - storage registrations;
  - creating DAOs.

  Members never need NEAR of their own to take part.
- **About 0.38 NEAR sits in each active member's account.** NEAR holds a
  call's attached gas up front, at ten times the gas price, and refunds what
  isn't used a block later. The bot keeps enough in each account for that
  hold, and the hold comes back after every call. Only the gas actually used
  is spent, about 0.001–0.005 NEAR per action.
- **Tokens:** the DAO's creator holds the whole supply at first. They pass
  it on with `/send`, or `/tip` as a reply to someone's message. Members
  `/stake` to get voting weight.

### Safety

- **Nobody can change a DAO's contracts.** Contract accounts have no keys,
  and their code is fixed by hash. A new version is a new hash, which a DAO
  adopts only by switching models by proposal.
- **The treasury only does what governance passed.** The core's sole member
  is the orbit, and the core has no open "anyone can propose" role.
- **Governance can't be broken by accident.** Every orbit refuses proposals
  that would:
  - replace the core's policy;
  - remove or reshape its governance role, except by a proper swap;
  - set a proposal bond or a proposal period under an hour.
- **Votes can't count twice.** Stake is read at each proposal's snapshot,
  and conviction locks the stake that backs a proposal.
- **Money leaving NEAR is checked:**
  - Intents deposits only go into quotes that outlive the proposal;
  - EVM and Hyperliquid signatures must recover to the DAO's own address
    before anything is sent.

### Costs

| | NEAR |
| --- | --- |
| Publish the nine modules, staking and token (once per network) | ~255 (2.55 MB at 10× normal storage) |
| Protean's Sputnik factory (once per network) | ~49 |
| Each DAO, through Protean's factory | ~0.6 (~6.6 through `sputnikv2.testnet`, which still stores a full copy of the DAO code in each DAO) |
| A model switch | ~0.25 for the new orbit |
| Each active member | ~0.38 held for gas (returned after every call), plus ~0.01 staking storage |

## Repository layout

```
orbits/                    Rust contracts (Cargo workspace)
  modules/                 the nine governance modules, one contract each
  orbit/                   the engine the modules are built from (a feature per model)
  orbit-staking/           a DAO's staking contract: stake history, locks
  orbit-common/            which proposals may reach the core; the calls to it
  governance-token/        fixed-supply NEP-141 token
  core-tests/              checks against the real Sputnik contract
  testing/mock-signer/     a stand-in Chain Signatures signer for local runs
  deployments/             published code hashes, per network
bot/                       Telegram and Discord bot (Node)
  src/platforms/commands/  the commands, one file per topic, shared by both platforms
  src/near/                NEAR: accounts, orbit, staking, Sputnik, integrations
  scripts/                 publish contracts, deploy the factory, local node runs
docs/                      SPEC.md (design), sandbox.md (local node), hosting.md, testnet-check.md
Dockerfile, railway.json   hosting the bot
supabase/schema.sql        the bot's database
```

## Try it

### 1. Contract tests (Rust 1.85+)

```bash
cd orbits && cargo test
```

Expect 70 tests to pass. Among other things, they show that:

- a Sputnik DAO whose only member is an orbit executes what the orbit passes,
  refuses everyone else, and moves to a new orbit in one proposal;
- each model decides like its Spaces counterpart;
- a passed proposal reaches the DAO exactly once, and only after its
  timelock;
- every proposal, model setting and DAO policy the bot creates works on the
  contracts (`bot/test/fixtures`).

### 2. Bot tests (Node 20+)

```bash
cd bot && npm install && npm test
```

Expect `pass 61`. The commands run against a fake chain.

### 3. A local NEAR node

A sandbox runs everything against the real contracts, at no cost.
`./bot/scripts/sandbox-prepare.sh` gets the node and every contract. Then:

- `sandbox-flow.js` runs a DAO's whole life and every integration;
- `sandbox-models.js` runs each model's own mechanics.

See [docs/sandbox.md](docs/sandbox.md).

### 4. Testnet

You need:

- a funded operator account;
- a Telegram or Discord bot token;
- a Supabase project (run `supabase/schema.sql` in it);
- an AWS KMS key.

```bash
# Build the contracts (needs cargo-near)
cd orbits
for c in modules/* orbit-staking governance-token; do (cd $c && cargo near build non-reproducible-wasm); done

# Configure, then publish the contracts once as global contracts
cd ../bot
cp ../.env.example .env                  # fill it in
node scripts/publish-contracts.js        # shows the cost
node scripts/publish-contracts.js --yes  # publishes all (or name some models)

# Protean's own Sputnik factory: each DAO then costs ~0.6 NEAR
./scripts/build-sputnik.sh
node scripts/deploy-factory.js           # shows the cost (~49 NEAR, once)
node scripts/deploy-factory.js --yes     # then set SPUTNIK_FACTORY_ID and DAO_CREATE_DEPOSIT=0.1

npm start                                # Telegram, and Discord if its token is set
```

To keep the bot running without your computer, host it: the repository
includes a `Dockerfile` and a Railway config. See [docs/hosting.md](docs/hosting.md).

In a Telegram group, with the bot as a group admin:

| Do | See |
| --- | --- |
| `/createdao ark ARK 1000000` | 🏛 ark is live, with tokenWeighted governance; you hold 1,000,000 ARK |
| Reply to a member's message: `/tip 1000` | ✅ Sent 1000 ARK, with a link to the transaction |
| Each member: `/stake 1000` | ✅ Staked |
| `/pay 1 NEAR me test payout` | 📝 New proposal #0, with For / Against / Abstain buttons |
| Members press **For** | 🗳 Voted for |
| After voting ends: **Execute** | ▶️ #0 was executed on the DAO |
| `/treasury` | The DAO's NEAR balance, 1 NEAR lower |
| `/switchmodel quadratic`, vote, execute | 🔀 The DAO now runs quadratic governance. Same treasury, same stakes |

Voting periods default to an hour so a whole lifecycle fits in a demo;
`.env.example` shows how to lengthen them.

## Commands

| | |
| --- | --- |
| Setup | `/createdao <name> <SYMBOL> <supply> [model] [members...]` · `/link <dao> [orbit]` · `/unlink` · `/switchmodel <model> [members...]` |
| Wallet | `/wallet` · `/stake` · `/unstake` · `/send <amount> <NEAR\|token> <account>` · `/tip <amount>` (as a reply to someone's message; or name an account) |
| The DAO | `/dao` · `/treasury` · `/proposals` · `/proposal <id>` · `/council` |
| Proposing | `/pay <amount> <NEAR\|token> <account> <description>` · `/signal <text>` |
| Treasury | `/swap <amount> <from> <to> [slippage%]` (on Rhea) · `/liquidstake <amount> [linear\|metapool\|nearx]` · `/liquidunstake <amount> [provider]` · `/liquidwithdraw [provider]` |
| NEAR Intents | `/buy <amount> <from> <to>[@chain] [slippage%]` · `/paychain <amount> <token>@<chain> <address> <description>` · `/intentsstatus <id>` · `/intentswithdraw <amount> <token>` |
| EVM (Chain Signatures) | `/evm` · `/aave supply\|withdraw <amount\|all> [USDC\|ETH]` (Aave on Base) |
| Hyperliquid | `/hyperliquid` · `/hlagent <address\|bot> [name]` · `/hlrevoke [name]` · `/hlsend <amount> <address>` · `/hltraders add\|remove <account>` · `/hllimits size <usd>\|leverage <n>\|markets <coins>` · `/long <coin> <usd> [leverage]` · `/short <coin> <usd> [leverage]` · `/close <coin>` |
| Deciding | `/vote <id> for\|against\|abstain` · `/execute <id>` · `/cancel <id>` |
| Optimistic | `/challenge <id>` · `/resolvechallenge <id>` |
| Liquid | `/delegate <account>` · `/undelegate` · `/resolve <id> [delegator]` |
| Conviction | `/support <id>` · `/withdrawsupport` · `/queue <id>` |
| Delegate | `/startelection` · `/declarecandidacy` · `/voteinelection <candidates...>` · `/finalizeelection` · `/recall <member>` · `/voterecall <id> <choice>` · `/finalizerecall <id>` |
| Sortition | `/registereligible` · `/withdraweligibility` · `/draw` |
| Sowellian | `/position <id> yes\|no <amount>` · `/proposeresolution <id> success\|failure` · `/dispute <id>` · `/adjudicate <id> <outcome>` · `/finalizeresolution <id>` · `/claimposition <id>` · `/forfeitbond <id>` |
| Decision markets | `/seed <id> <tokens> <NEAR>` · `/split <id> <amount> <NEAR\|token>` · `/trade <id> pass\|fail <amount> <NEAR\|token>` · `/merge` · `/redeem <id>` · `/reclaimliquidity <id>` |

`/help` and Telegram's "/" menu show only the commands for the chat's model.
A chat without a DAO sees just `/help`, `/createdao`, `/link`, `/wallet` and
`/send`. Accounts can be written as `me`. Replies link user and treasury
addresses to the explorer, next to the address itself, which can be tapped
to copy.

The bot also posts on its own when voting on a proposal ends, when a
passed proposal can be executed (with an Execute button), when its
execution window is about to close, and when it expires.

Each command is defined once, in `bot/src/platforms/commands/`, and both
Telegram and Discord run it.

## Built with

- [Sputnik DAO](https://github.com/near-daos/sputnik-dao-contract) (MIT),
  unmodified, as every DAO's core and factory.
- NEAR global contracts: the modules, staking, the token, and the Sputnik
  DAO code are each published once by code hash and shared by every DAO.
- NEAR named accounts and sub-accounts, for members and each DAO's contracts.
- [NEAR Intents](https://docs.near-intents.org/) and
  [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)
  for other chains.
- [Rhea Finance](https://rhea.finance/), [LiNEAR](https://github.com/linear-protocol/LiNEAR),
  [Meta Pool](https://github.com/Narwallets/meta-pool),
  [Stader NearX](https://github.com/stader-labs/near-liquid-token),
  [Aave](https://aave.com/) and [Hyperliquid](https://hyperliquid.xyz/).
- Protean's EVM contracts and bot ([Spaces](https://github.com/replico-labs/Spaces))
  as the model rules and the chat layer's base.
