# Protean on NEAR

Protean turns a group chat into a DAO. This repository is Protean's NEAR
version: the **Orbits** contracts, and the Protean bot for Telegram and
Discord.

**Orbits** is a modular NEAR governance framework that provides
interchangeable governance modules for Sputnik DAO, for building and evolving
onchain organizations. Communities can swap their governance model by
proposal without moving their treasury.

> Status: contracts and bot are built and tested locally (below). They
> haven't run against testnet yet.

## How it works

- **Core:** an unmodified Sputnik DAO, created through the official factory.
  It holds the treasury and executes proposals.
- **Orbit:** the governance module. It's the core's only member: people
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
  orbit/                   the orbit: one contract, nine models
  orbit-staking/           a DAO's staking contract: stake history, locks
  orbit-common/            which proposals may reach the core; the calls to it
  governance-token/        fixed-supply NEP-141 token
  core-tests/              checks against the real Sputnik contract
  deployments/             published code hashes, per network
bot/                       Telegram and Discord bot (Node)
  src/platforms/commands/  the commands, shared by both platforms
  src/near/                NEAR: accounts, orbit, staking, Sputnik, deployment
  scripts/                 publish the contracts; create a DAO from the shell
docs/                      SPEC.md (design), testnet-check.md
supabase/schema.sql        the bot's database
```

## Try it

### 1. Contract tests (Rust 1.85+)

```bash
cd orbits && cargo test
```

Expect every suite to pass (68 tests). They show, among others, that:

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

Expect `pass 28`. The commands run against a fake chain.

### 3. Run it on testnet

You need a funded testnet operator account, a Telegram or Discord bot token,
a Supabase project (run `supabase/schema.sql`) and an AWS KMS key.
Publishing the contracts costs about 78 NEAR, once; each DAO after that
costs well under 1 NEAR.

```bash
# Build the contracts (needs cargo-near)
cd orbits
for c in orbit orbit-staking governance-token; do (cd $c && cargo near build non-reproducible-wasm); done

# Configure, then publish the contracts once as global contracts
cd ../bot
cp ../.env.example .env        # fill it in
node scripts/publish-contracts.js        # shows the cost
node scripts/publish-contracts.js --yes  # publishes

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
| Wallet | `/wallet` · `/stake` · `/unstake` · `/send <amount> <NEAR\|token> <account>` |
| The DAO | `/dao` · `/treasury` · `/proposals` · `/proposal <id>` · `/council` |
| Proposing | `/pay <amount> <NEAR\|token> <account> <description>` · `/signal <text>` |
| Deciding | `/vote <id> for\|against\|abstain` · `/execute <id>` · `/cancel <id>` |
| Optimistic | `/challenge <id>` · `/resolvechallenge <id>` |
| Liquid | `/delegate <account>` · `/undelegate` · `/resolve <id> [delegator]` |
| Conviction | `/support <id>` · `/withdrawsupport` · `/queue <id>` |
| Delegate | `/startelection` · `/declarecandidacy` · `/voteinelection <candidates...>` · `/finalizeelection` · `/recall <member>` · `/voterecall <id> <choice>` · `/finalizerecall <id>` |
| Sortition | `/registereligible` · `/withdraweligibility` · `/draw` |
| Sowellian | `/position <id> yes\|no <amount>` · `/proposeresolution <id> success\|failure` · `/dispute <id>` · `/adjudicate <id> <outcome>` · `/finalizeresolution <id>` · `/claimposition <id>` · `/forfeitbond <id>` |
| Decision markets | `/seed <id> <tokens> <NEAR>` · `/split <id> <amount> <NEAR\|token>` · `/trade <id> pass\|fail <amount> <NEAR\|token>` · `/merge` · `/redeem <id>` · `/reclaimliquidity <id>` |

`/help` shows only the commands for the chat's model. Accounts can be
written as `me`.

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
- NEAR global contracts: the orbit, staking and token contracts are published
  once by code hash, and every DAO uses them without its own copy.
- NEAR named accounts and sub-accounts (`tg123456.orbits.testnet`,
  `tw.ark.orbits.testnet`).
- Protean's EVM contracts and bot ([Spaces](https://github.com/replico-labs/Spaces))
  as the model rules and the chat layer's base.
