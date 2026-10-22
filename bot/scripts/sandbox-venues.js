// Installs NEAR DeFi venues on a local near-sandbox, for the treasury
// commands (/swap, /liquidstake, /buy...): wrapped NEAR, a test USDC, Rhea's
// exchange (the released Ref contract) with a NEAR/USDC pool, LiNEAR, and
// the NEAR Intents Verifier, and a stand-in for the Chain Signatures signer
// (orbits/testing/mock-signer: same interface, one public test key).
// Appends their accounts to bot/.env.sandbox.
//
//   node scripts/sandbox-venues.js ~/.near-sandbox <dir with ref_exchange_release.wasm, wnear.wasm, linear.wasm, defuse-0.2.10.wasm, governance_token.wasm, mock_signer.wasm>
//
// Run after scripts/sandbox-setup.js. Where the wasm comes from:
//   ref_exchange_release.wasm  github.com/marco-sundsk/ref-contracts, releases/
//   wnear.wasm                 github.com/near/intents, releases/
//   defuse-0.2.10.wasm         github.com/near/intents, releases/ (the Verifier)
//   mock_signer.wasm           orbits/testing/mock-signer, built with cargo near
//   linear.wasm                github.com/linear-protocol/LiNEAR, built with Rust 1.69
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [home, wasmDir] = process.argv.slice(2);
if (!home || !wasmDir) {
  console.error("Usage: node scripts/sandbox-venues.js <sandbox home> <wasm dir>");
  process.exit(1);
}
process.env.NEAR_NETWORK = "sandbox";
const { Account, JsonRpcProvider, KeyPair, actions, nearToYocto } = await import("near-api-js");
const { RPC_URL } = await import("../src/config.js");

const TGAS = 1_000_000_000_000n;
const provider = new JsonRpcProvider({ url: RPC_URL });
const genesis = JSON.parse(readFileSync(join(home, "validator_key.json")));
const root = new Account(genesis.account_id, provider, genesis.secret_key ?? genesis.private_key);
const ids = { wrap: `wrap.${root.accountId}`, usdc: `usdc.${root.accountId}`, rhea: `rhea.${root.accountId}`, linear: `linear.${root.accountId}`, intents: `intents.${root.accountId}`, signer: `signer.${root.accountId}` };
const call = (account, contractId, methodName, args = {}, deposit = 0n, tgas = 100n) => account.callFunction({ contractId, methodName, args, deposit, gas: tgas * TGAS });

/** Creates `accountId` with `near`, deploys `wasm` and calls `init`; returns it signing with its own key. */
async function deploy(accountId, wasm, near, init) {
  const key = KeyPair.fromRandom("ed25519");
  await root.createAccount({ newAccountId: accountId, publicKey: key.getPublicKey().toString(), nearToTransfer: nearToYocto(near) });
  const account = new Account(accountId, provider, key.toString());
  await account.signAndSendTransaction({
    receiverId: accountId,
    actions: [actions.deployContract(readFileSync(join(wasmDir, wasm))), actions.functionCall(init.method, init.args, 100n * TGAS, 0n)],
  });
  console.log(`  ${accountId} (${wasm})`);
  return account;
}

if (await provider.viewAccount({ accountId: ids.rhea }).then(() => true, () => false)) throw new Error(`${ids.rhea} already exists; set up a fresh sandbox`);

console.log("Deploying venues...");
await deploy(ids.wrap, "wnear.wasm", "10", { method: "new", args: {} });
await deploy(ids.usdc, "governance_token.wasm", "10", {
  method: "new",
  args: { owner_id: root.accountId, total_supply: String(10_000_000n * 10n ** 6n), name: "USD Coin (sandbox)", symbol: "USDC", decimals: 6 },
});
const rhea = await deploy(ids.rhea, "ref_exchange_release.wasm", "50", {
  method: "new",
  args: { owner_id: root.accountId, boost_farm_id: root.accountId, burrowland_id: root.accountId, exchange_fee: 4, referral_fee: 1 },
});
await deploy(ids.linear, "linear.wasm", "30", { method: "new", args: { owner_id: root.accountId } });
await deploy(ids.intents, "defuse-0.2.10.wasm", "30", {
  method: "new",
  args: { config: { wnear_id: ids.wrap, fees: { fee: 0, fee_collector: root.accountId }, roles: { super_admins: [], admins: {}, grantees: {} } } },
});
for (const token of [ids.wrap, ids.usdc]) await call(root, token, "storage_deposit", { account_id: ids.intents, registration_only: true }, nearToYocto("0.00125"), 30n);
await deploy(ids.signer, "mock_signer.wasm", "5", { method: "new", args: {} });

console.log("Opening a NEAR/USDC pool on Rhea: 1,000 NEAR and 5,000 USDC (5 USDC per NEAR)...");
const near = 1_000n * 10n ** 24n;
const dollars = 5_000n * 10n ** 6n;
const poolId = await call(root, ids.rhea, "add_simple_pool", { tokens: [ids.wrap, ids.usdc], fee: 30 }, nearToYocto("0.1"));
for (const token of [ids.wrap, ids.usdc]) await call(root, token, "storage_deposit", { account_id: ids.rhea, registration_only: true }, nearToYocto("0.00125"), 30n);
await call(root, ids.wrap, "storage_deposit", { account_id: root.accountId, registration_only: true }, nearToYocto("0.00125"), 30n);
await call(root, ids.rhea, "storage_deposit", { account_id: root.accountId, registration_only: false }, nearToYocto("0.1"), 30n);
await call(root, ids.rhea, "register_tokens", { token_ids: [ids.wrap, ids.usdc] }, 1n, 30n);
await call(root, ids.wrap, "near_deposit", {}, near, 30n);
for (const [token, amount] of [[ids.wrap, near], [ids.usdc, dollars]]) {
  await call(root, token, "ft_transfer_call", { receiver_id: ids.rhea, amount: String(amount), msg: "" }, 1n, 150n);
}
await call(root, ids.rhea, "add_liquidity", { pool_id: Number(poolId), amounts: [String(near), String(dollars)] }, nearToYocto("0.01"), 100n);
const back = await provider.callFunction({ contractId: ids.rhea, method: "get_return", args: { pool_id: Number(poolId), token_in: ids.wrap, amount_in: String(10n ** 24n), token_out: ids.usdc } });
console.log(`  pool ${poolId}: 1 NEAR → ${Number(back) / 1e6} USDC`);

const envFile = new URL("../.env.sandbox", import.meta.url);
if (!existsSync(envFile)) throw new Error("Run scripts/sandbox-setup.js first");
appendFileSync(
  envFile,
  [
    "# Venues, written by scripts/sandbox-venues.js",
    `RHEA_EXCHANGE_ID=${ids.rhea}`,
    `WRAP_NEAR_ID=${ids.wrap}`,
    `LINEAR_ID=${ids.linear}`,
    `INTENTS_ID=${ids.intents}`,
    `CHAIN_SIGNER_ID=${ids.signer}`,
    `KNOWN_TOKENS={"USDC":"${ids.usdc}"}`,
    "",
  ].join("\n"),
);
console.log("Added the venues to bot/.env.sandbox");
