# Running Protean on a local NEAR node

A sandbox is a full NEAR node on your machine, the same software as testnet
and mainnet, with as much NEAR as you want. `bot/scripts/sandbox-flow.js`
runs Protean end to end on it through the bot's own commands; only the chat
and the key store are in memory. Every account, contract and DAO is real.

## 1. Start a sandbox

Download `near-sandbox` 2.12 or later (the contracts need protocol 84):

```bash
curl -O https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.13.0/near-sandbox.tar.gz
tar xzf near-sandbox.tar.gz
./Linux-x86_64/near-sandbox --home ~/.near-sandbox init
./Linux-x86_64/near-sandbox --home ~/.near-sandbox run
```

On macOS use `Darwin-arm64` in the URL.

## 2. Build Sputnik and the Orbits contracts

```bash
git clone https://github.com/near-daos/sputnik-dao-contract && cd sputnik-dao-contract
git checkout 5434a59dec23ee0c49df8c8c4350c208a7e75b0b
rm rust-toolchain.toml && cargo update -p near-sdk -p near-contract-standards --precise 5.29.1
mkdir -p ../sputnik-wasm
for c in sputnikdao2 sputnikdao-factory2; do (cd $c && cargo near build non-reproducible-wasm); done
cp target/near/*/*.wasm ../sputnik-wasm/

cd <this repo>/orbits
for c in modules/* orbit-staking governance-token; do (cd $c && cargo near build non-reproducible-wasm); done
```

## 3. Set up, publish, run

```bash
cd bot
node scripts/sandbox-setup.js ~/.near-sandbox ../../sputnik-wasm     # factory + operator, writes .env.sandbox
node --env-file=.env.sandbox scripts/publish-contracts.js --yes       # all eleven, as global contracts
node --env-file=.env.sandbox scripts/sandbox-flow.js
```

To also try the treasury commands, install the venues before running the
flow: Rhea's released exchange contract (from
`github.com/marco-sundsk/ref-contracts`, `releases/ref_exchange_release.wasm`),
wrapped NEAR and the NEAR Intents Verifier (`github.com/near/intents`,
`releases/wnear.wasm` and `releases/defuse-0.2.10.wasm`), LiNEAR
(`github.com/linear-protocol/LiNEAR`, built with Rust 1.69:
`cargo build -p linear --target wasm32-unknown-unknown --release`) and
`governance_token.wasm` from `orbits/target/near`, as a test USDC, and
`mock_signer.wasm`, a stand-in for the Chain Signatures signer with the real
interface and key derivation and one public test key (build
`orbits/testing/mock-signer` with cargo near). Put the six files in one
folder, then:

```bash
node scripts/sandbox-venues.js ~/.near-sandbox <that folder>
```

It opens a NEAR/USDC pool on Rhea with 1,000 NEAR and 5,000 USDC.

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
