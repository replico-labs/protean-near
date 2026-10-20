# Protean on NEAR

Protean turns a group chat into a DAO. This repository is Protean's NEAR
version: the **Orbits** contracts and the Protean NEAR bot for Telegram and
Discord.

**Orbits** is a modular NEAR governance framework that provides
interchangeable governance modules for Sputnik DAO, for building and evolving
onchain organizations. Communities can swap their governance model by
proposal without moving their treasury.

> Status: early. The core design is checked against Sputnik's own code
> (below). The orbits, factory and bot are not built yet.

## How it works

- **Core:** an unmodified Sputnik DAO, created through the official factory.
  It holds the treasury and executes proposals.
- **Orbit:** a governance module (for example token weight). It's the core's
  only voter: people propose and vote in the orbit, and when a vote passes the
  orbit's single vote executes it on the core.
- **Swap orbit:** one proposal hands the core to a different orbit. The
  treasury never moves.

Because the core is plain Sputnik, every Protean DAO also works in Sputnik
tools such as Trezu. Full design: [docs/SPEC.md](docs/SPEC.md).

## Repository layout

```
orbits/        Rust contracts (Cargo workspace)
  core-tests/  checks the core policy against the real Sputnik contract
docs/          SPEC.md (design), testnet-check.md (manual testnet check)
supabase/      schema.sql for the bot's database
.env.example   the bot's configuration
```

## Try it

Requires Rust 1.85 or later.

```bash
cd orbits
cargo test
```

Expect `6 passed`. The tests run Sputnik's own contract code with the Orbits
core policy and check that:

- the orbit's single vote executes a proposal;
- the orbit can reject a proposal;
- other accounts can neither propose nor vote;
- a swap hands control to the new orbit, and the old orbit loses it.

## Built with

- [Sputnik DAO](https://github.com/near-daos/sputnik-dao-contract) (MIT),
  unmodified, as the core. Orbit logic will be adapted from it.
- NEAR global contracts, named accounts and sub-accounts.
- Protean's existing bot ([Spaces](https://github.com/replico-labs/Spaces) on
  EVM, Vortexes on Solana) as the base for the NEAR bot.
