// Prepares a local NEAR node (near-sandbox) for the bot: the official
// Sputnik factory with its DAO code, and a funded operator account. Writes
// bot/.env.sandbox, which the other scripts read with NEAR_NETWORK=sandbox.
//
//   near-sandbox --home ~/.near-sandbox init && near-sandbox --home ~/.near-sandbox run
//   node scripts/sandbox-setup.js ~/.near-sandbox <dir with sputnikdao2.wasm and sputnikdao_factory2.wasm>
//
// Build the Sputnik wasm from github.com/near-daos/sputnik-dao-contract
// (cargo near build non-reproducible-wasm in sputnikdao2 and
// sputnikdao-factory2). Sandbox NEAR has no value: the genesis account
// test.near holds plenty.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [home, sputnikDir] = process.argv.slice(2);
if (!home || !sputnikDir) {
  console.error("Usage: node scripts/sandbox-setup.js <sandbox home> <sputnik wasm dir>");
  process.exit(1);
}
process.env.NEAR_NETWORK = "sandbox";
const { Account, JsonRpcProvider, KeyPair, actions, nearToYocto } = await import("near-api-js");
const { RPC_URL, SPUTNIK_FACTORY_ID } = await import("../src/config.js");

const TGAS = 1_000_000_000_000n;
const OPERATOR = "protean.test.near";
const provider = new JsonRpcProvider({ url: RPC_URL });
const genesis = JSON.parse(readFileSync(join(home, "validator_key.json")));
const root = new Account(genesis.account_id, provider, genesis.secret_key ?? genesis.private_key);

async function exists(accountId) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(SPUTNIK_FACTORY_ID))) {
  console.log(`Creating the Sputnik factory at ${SPUTNIK_FACTORY_ID}...`);
  const key = KeyPair.fromRandom("ed25519");
  await root.createAccount({ newAccountId: SPUTNIK_FACTORY_ID, publicKey: key.getPublicKey().toString(), nearToTransfer: nearToYocto("100") });
  const factory = new Account(SPUTNIK_FACTORY_ID, provider, key.toString());
  await factory.signAndSendTransaction({
    receiverId: SPUTNIK_FACTORY_ID,
    actions: [actions.deployContract(readFileSync(join(sputnikDir, "sputnikdao_factory2.wasm"))), actions.functionCall("new", {}, 100n * TGAS)],
  });
  // As Sputnik's own tests do: store the DAO code (it's published as a global contract) and make it the default.
  const stored = await factory.signAndSendTransaction({
    receiverId: SPUTNIK_FACTORY_ID,
    actions: [actions.functionCall("store", readFileSync(join(sputnikDir, "sputnikdao2.wasm")), 300n * TGAS, nearToYocto("60"))],
  });
  const codeHash = JSON.parse(Buffer.from(stored.status.SuccessValue, "base64").toString());
  await factory.callFunction({ contractId: SPUTNIK_FACTORY_ID, methodName: "set_default_code_hash", args: { code_hash: codeHash }, gas: 100n * TGAS });
  await factory.callFunction({
    contractId: SPUTNIK_FACTORY_ID,
    methodName: "store_contract_metadata",
    args: { code_hash: codeHash, metadata: { version: [3, 2], commit_id: "5434a59dec23ee0c49df8c8c4350c208a7e75b0b", changelog_url: null }, set_default: true },
    gas: 100n * TGAS,
  });
  console.log(`Sputnik DAO code ${codeHash} is the factory's default`);
}

const operatorKey = KeyPair.fromRandom("ed25519");
if (await exists(OPERATOR)) {
  // Re-running: give the existing operator a fresh key.
  throw new Error(`${OPERATOR} already exists; restart the sandbox from a fresh home to set up again`);
}
await root.createAccount({ newAccountId: OPERATOR, publicKey: operatorKey.getPublicKey().toString(), nearToTransfer: nearToYocto("2000") });
console.log(`Created the operator ${OPERATOR} with 2000 NEAR`);

const envFile = new URL("../.env.sandbox", import.meta.url);
writeFileSync(
  envFile,
  [
    "# Written by scripts/sandbox-setup.js for a local near-sandbox. Sandbox keys only.",
    "NEAR_NETWORK=sandbox",
    `NEAR_OPERATOR_ACCOUNT_ID=${OPERATOR}`,
    `NEAR_OPERATOR_PRIVATE_KEY=${operatorKey.toString()}`,
    "DAO_CREATE_DEPOSIT=0.1",
    "",
  ].join("\n"),
);
console.log("Wrote bot/.env.sandbox");
