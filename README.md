# Protean on NEAR

Protean turns a group chat into a DAO. This repository is Protean's NEAR
version: the **Orbits** contracts, and the Protean bot for Telegram and
Discord.

**Orbits** is a modular NEAR governance framework that provides
interchangeable governance modules for Sputnik DAO, for building and evolving
onchain organizations. Communities can swap their governance model by
proposal without moving their treasury.

> Status: the token-weight orbit, the bot and the deploy script are built and
> tested locally (below). They haven't run against testnet yet.

## How it works

- **Core:** an unmodified Sputnik DAO, created through the official factory.
  It holds the treasury and executes proposals.
- **Orbit:** a governance module. It's the core's only member: people propose
  and vote in the orbit, and when a vote passes, the orbit's single vote
  executes it on the core.
- **Swap:** one proposal hands the core to a different orbit. The treasury
  never moves.

The first orbit is **token weight**: members stake the DAO's token through
Sputnik's own staking contract, and their stake is their vote. Because the
core is plain Sputnik, a Protean DAO also works in Sputnik tools such as
Trezu. Full design: [docs/SPEC.md](docs/SPEC.md).

## Repository layout

```
orbits/                    Rust contracts (Cargo workspace)
  orbit-common/            rules every orbit shares: which proposals may reach the core
  token-weight-orbit/      the token-weight orbit
  governance-token/        fixed-supply NEP-141 token for a DAO
  sputnik-staking/         Sputnik's staking contract, copied unmodified
  core-tests/              checks the design against the real Sputnik contract
bot/                       Telegram and Discord bot (Node)
  src/platforms/           commands, shared by both chat platforms
  src/near/                NEAR calls: accounts, orbit, staking, treasury
  scripts/publish-contracts.js  publishes the contracts once, as global contracts
  scripts/deploy-dao.js    creates a complete DAO that uses them
orbits/deployments/        published code hashes, per network
docs/                      SPEC.md (design), testnet-check.md
supabase/schema.sql        the bot's database
```

## Try it

### 1. Contract tests (Rust 1.85+)

```bash
cd orbits
cargo test
```

Expect every suite to pass (45 tests). They show that:

- a Sputnik DAO whose only member is an orbit executes what the orbit passes,
  and refuses everyone else;
- a swap hands the DAO to the new orbit in one proposal;
- the orbit refuses proposals that would lock the DAO;
- token-weight voting passes, rejects and expires proposals correctly, and a
  passed proposal reaches the DAO exactly once;
- every proposal the bot makes decodes and executes on Sputnik
  (`bot/test/fixtures/kinds.json`).

### 2. Bot tests (Node 20+)

```bash
cd bot
npm install
npm test
```

Expect `pass 20`. The commands run against a fake chain.

### 3. Run it on testnet

You need a funded testnet account for the operator, a Telegram or Discord bot
token, a Supabase project and an AWS KMS key. Publishing the contracts costs
about 51 NEAR, once; each DAO after that costs about 0.4 NEAR.

```bash
# Build the contracts (needs cargo-near)
cd orbits
for c in token-weight-orbit governance-token sputnik-staking; do (cd $c && cargo near build non-reproducible-wasm); done

# Configure: fill in .env (see .env.example), and run supabase/schema.sql in Supabase
cd ../bot
cp ../.env.example .env

# Publish the three contracts once, as global contracts (shows the cost; --yes to pay it)
node scripts/publish-contracts.js
node scripts/publish-contracts.js --yes

# Create a DAO: Sputnik core, ARK token, staking contract and orbit, all using the shared code
node scripts/deploy-dao.js ark ARK 1000000
```

Expect it to print `/link ark.sputnikv2.testnet tw.ark.<operator>`. Then:

```bash
npm run telegram     # or: npm run discord
```

In a Telegram group with the bot:

| Do | See |
| --- | --- |
| `/link ark.sputnikv2.testnet tw.ark.<operator>` (as a group admin) | ✅ Linked, with the voting token |
| `/wallet` | Your new NEAR account, e.g. `tg123456.<operator>` |
| Send ARK to that account from the token owner, then `/stake 100` | ✅ Staked; voting weight 100 |
| `/pay 1 NEAR <your account> test payout` | 📝 New proposal #0 with For / Against buttons |
| Press **For** (with more than half of all staked ARK) | It passed and is being executed |
| `/proposal 0` | Status `Executed`; on the DAO: proposal 0, `Approved` |
| `/treasury` | The DAO's NEAR balance, 1 NEAR lower |

## Commands

| Command | What it does |
| --- | --- |
| `/link <dao> <orbit>` · `/unlink` | Link this chat to a DAO (admins) |
| `/wallet` | Your account, balances and voting weight |
| `/stake <amount>` · `/unstake <amount>` · `/withdraw <amount>` | Manage your voting weight |
| `/dao` · `/treasury` · `/proposals` · `/proposal <id>` | The DAO and its proposals |
| `/pay <amount> <NEAR\|token> <account> <description>` | Propose a payment from the treasury |
| `/signal <text>` | Propose a decision with nothing to execute |
| `/swap <orbit> <description>` | Propose handing the DAO to another orbit |
| `/vote <id> for\|against` · `/execute <id>` · `/finalize <id>` | Decide |

## Accounts and keys

Each chat user gets a named NEAR account under the operator, such as
`tg123456.orbits.testnet`, created on first use. Its key is generated by the
bot and stored envelope-encrypted with AWS KMS in Supabase: a custodial model,
as in Protean's EVM bot. The bot's KMS access is limited to the encryption
context `{"app": "protean-near"}`. Contract accounts are created with no
access key and use shared code by hash, so their code can't be changed.

## Built with

- [Sputnik DAO](https://github.com/near-daos/sputnik-dao-contract) (MIT):
  the core, unmodified; its staking contract, copied unmodified; and the
  token-weight voting rules, adapted into the orbit.
- NEAR global contracts: the orbit, token and staking contract are published
  once by code hash, and every DAO uses them without storing its own copy.
- NEAR named accounts and sub-accounts (`tg123456.orbits.testnet`,
  `tw.ark.orbits.testnet`).
- Protean's EVM bot ([Spaces](https://github.com/replico-labs/Spaces) on EVM,
  Vortexes on Solana) as the base for the bot's chat layer.
