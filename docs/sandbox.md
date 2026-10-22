# Running Protean on a local NEAR node

A sandbox is a full NEAR node on your machine, the same software as testnet
and mainnet, with as much NEAR as you want. `bot/scripts/sandbox-flow.js`
runs Protean end to end on it through the bot's own commands; only the chat
and the key store are in memory. Every account, contract and DAO is real.

## 1. Prepare (once)

```bash
./bot/scripts/sandbox-prepare.sh
```

It needs git, curl, Node 20+, Rust (rustup) and cargo-near, on macOS or
Linux x86_64, and puts everything in `.sandbox/` at the repo root (git
ignores it):

| What | From |
| --- | --- |
| The `near-sandbox` node, 2.13 (the contracts need protocol 84) | NEAR's builds |
| Sputnik's factory and DAO contract, at the revision Orbits is tested against | `github.com/near-daos/sputnik-dao-contract`, built with Orbits' near-sdk |
| The nine Orbits modules, staking, the token, and a stand-in Chain Signatures signer (same interface and key derivation, one public test key) | This repo, built with cargo near |
| Rhea's exchange (the released Ref contract) | `github.com/marco-sundsk/ref-contracts`, `releases/` |
| Wrapped NEAR and the NEAR Intents Verifier | `github.com/near/intents`, `releases/` |
| LiNEAR | `github.com/linear-protocol/LiNEAR`, built with Rust 1.69, which the script installs |

The first run takes a while; later runs only rebuild the Orbits contracts.
It ends by printing the commands below with your paths.

## 2. Start the node

In its own terminal tab, left running:

```bash
ulimit -n 65535
.sandbox/bin/near-sandbox --home .sandbox/home init     # first time only
.sandbox/bin/near-sandbox --home .sandbox/home run
```

## 3. Set up and run

In another tab:

```bash
cd bot
node scripts/sandbox-setup.js ../.sandbox/home ../.sandbox/wasm     # Sputnik factory + operator, writes .env.sandbox
node --env-file=.env.sandbox scripts/publish-contracts.js --yes     # all eleven, as global contracts
node scripts/sandbox-venues.js ../.sandbox/home ../.sandbox/wasm    # Rhea, LiNEAR, NEAR Intents, the signer
node --env-file=.env.sandbox scripts/sandbox-flow.js                # the main flow and the integrations
node --env-file=.env.sandbox scripts/sandbox-models.js              # each governance model's own mechanics
```

`sandbox-models.js liquid sowellian` runs only those models. To start over,
stop the node, delete `.sandbox/home` and `bot/.env.sandbox`, and repeat
from step 2. Without `sandbox-venues.js`, the flow skips the treasury steps.

The sandbox clock is moved forward instead of waiting for voting periods.
Expect `All checks passed.` after these steps:

| Step | Checked |
| --- | --- |
| `/createdao` (token-weighted) | The Sputnik core's only member is the orbit |
| `/send`, `/stake` | Three members stake 500k, 300k and 100k |
| `/pay`, `/vote`, `/execute` | 600k for vs 300k against passes; refused before the timelock; the treasury pays out; a second execute is refused |
| `/switchmodel quadratic` | One proposal hands the core to the quadratic module; same treasury and stakes |
| Quadratic vote | Weights are square roots: bob and carol (√300k + √100k) outvote alice (√500k) |
| `/switchmodel conviction` | The new orbit becomes the staking contract's locker |
| `/support`, `/queue`, `/execute` | Support locks stake (unstaking is refused), conviction builds over time, the proposal queues and executes |
| Every module | All nine modules start on chain, each from its own published contract |
| Wrong settings | The token-weighted module refuses quadratic settings, and no account is created |
| Board DAO | Two of three members approve on Sputnik directly, and it pays out |
| `/swap 1 NEAR USDC` (with venues) | The DAO sells 1 NEAR on Rhea and receives the quoted USDC |
| `/swap 2 USDC NEAR 0.5%` | A token swap the other way, with a tighter minimum |
| A swap whose minimum isn't met | Someone moves the price first; the swap reverts and the treasury keeps its funds (as wNEAR) |
| `/liquidstake 2`, `/liquidunstake 1` | The DAO stakes with LiNEAR and holds LiNEAR; unstaking starts and an early withdraw is refused |
| `/treasury` | Lists USDC, wNEAR, and what's staked and unstaking |
| `/buy 1 NEAR BTC` | The proposal deposits 1 NEAR into the quote's account on the NEAR Intents Verifier. The 1Click API (quotes, solvers) can't run in a sandbox, so its answers are stood in for |
| `/intentswithdraw 3 NEAR` | A refund held in the DAO's NEAR Intents account returns to the treasury by proposal |
| `/evm` | The DAO's EVM address, derived from its account by the signer |
| `/hlagent <address> desk` | The DAO's key signs Hyperliquid's approveAgent; the signature recovers to the DAO's address (the post to Hyperliquid's API is stood in for) |
| `/aave supply 5` | Executing signs approve and supply; both recover to the DAO's address and supply 5 USDC to Aave on its behalf. Base itself can't be reached from a sandbox, so its nonce, fees, balances and the final send are stood in for |

`sandbox-models.js` gives each model its own DAO and chat:

| Model | Checked |
| --- | --- |
| Liquid | Dave delegates to carol and carol to bob; only alice and bob vote. Dave's and carol's stake follows their chains to bob's vote (550k for, 250k against), and it pays out |
| Optimistic | An unchallenged proposal executes after its window, with no vote. A challenged one goes to a vote, is defeated, and the challenger's 1,000-token bond comes back |
| Delegate | The first council passes a payout seat by seat; after the term an election seats carol and dave by stake; stakers then recall dave |
| Sortition | Three stakers join the pool; after the term a council is drawn from it, and it proposes and passes a payout that alice, no longer on it, can't vote on |
| Sowellian | A bonded proposal is approved by stake; bets of 1,000 YES and 500 NO; it executes; after measuring, alice proposes Success, carol disputes, stakers adjudicate Success; bob collects the 1,500 pool and alice gets both bonds back |
| Decision markets | The proposer seeds both markets; bob buys into the pass market; the pass average price beats the fail market's, so it passes and executes; bob redeems and the proposer reclaims the liquidity |
