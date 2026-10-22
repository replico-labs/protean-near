// Deploys Protean's own copy of Sputnik's factory, unmodified, at the
// revision Orbits is tested against. That factory shares the DAO contract
// as a global contract, so a new DAO costs about 0.01 NEAR instead of the
// ~5.4 an older factory (like sputnikv2.testnet today) charges to store a
// whole copy of the code in every DAO.
//
//   ./bot/scripts/build-sputnik.sh                # once: builds the wasm
//   node scripts/deploy-factory.js                # shows what it would do and the cost
//   node scripts/deploy-factory.js --yes          # deploys, paid by NEAR_OPERATOR_ACCOUNT_ID
//
// The factory goes at sputnik.<operator> (or FACTORY_ACCOUNT_ID), owned by
// the operator, with no key of its own: only the operator can store new DAO
// versions in it, and nobody can change its code. Safe to re-run: an
// interrupted run picks up where it stopped. Then set SPUTNIK_FACTORY_ID to
// it in .env and DAO_CREATE_DEPOSIT=0.1.
import "../src/logRedaction.js";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { KeyPair, actions, baseEncode, nearToYocto, yoctoToNear } from "near-api-js";
import { NETWORK_ID, OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY } from "../src/config.js";
import { operatorAccount, signingAccount, accountExists, view } from "../src/near/client.js";

const TGAS = 1_000_000_000_000n;
const SPUTNIK_REV = "5434a59dec23ee0c49df8c8c4350c208a7e75b0b";
const WASM_DIR = new URL("../../.sandbox/wasm/", import.meta.url);
// The factory's own code and state, plus room for its list of DAOs.
const FACTORY_FUNDING = nearToYocto("3");
// Storing the DAO code: a copy in the factory's state plus the global contract, 1 + 10 times
// its storage (Sputnik's store() checks this); the margin covers the key and is kept by the factory.
const storeDeposit = (code) => (BigInt(code.length) + 1000n) * 10n ** 19n * 11n;

async function main() {
  const confirmed = process.argv.includes("--yes");
  const factoryId = process.env.FACTORY_ACCOUNT_ID || `sputnik.${OPERATOR_ACCOUNT_ID}`;
  if (!factoryId.endsWith(`.${OPERATOR_ACCOUNT_ID}`)) throw new Error(`FACTORY_ACCOUNT_ID must be under ${OPERATOR_ACCOUNT_ID}`);
  const files = ["sputnikdao_factory2.wasm", "sputnikdao2.wasm"].map((f) => new URL(f, WASM_DIR));
  if (!files.every(existsSync)) throw new Error("Build Sputnik first: ./bot/scripts/build-sputnik.sh (from the repo root)");
  const [factoryCode, daoCode] = files.map((f) => readFileSync(f));
  const daoHash = baseEncode(createHash("sha256").update(daoCode).digest());

  const done = await view(factoryId, "get_default_code_hash").catch(() => null);
  if (done) {
    console.log(`${factoryId} is already set up on ${NETWORK_ID}: new DAOs use ${done}.`);
    console.log(`\nSet in .env, then restart the bot:\n  SPUTNIK_FACTORY_ID=${factoryId}\n  DAO_CREATE_DEPOSIT=0.1`);
    return;
  }

  const cost = FACTORY_FUNDING + storeDeposit(daoCode);
  console.log(`Factory:  ${factoryId} (Sputnik ${SPUTNIK_REV.slice(0, 7)}, ${(factoryCode.length / 1000).toFixed(1)} kB)`);
  console.log(`DAO code: ${daoHash} (${(daoCode.length / 1000).toFixed(1)} kB), shared by every DAO as a global contract`);
  if (!confirmed) {
    console.log(`\nThis costs about ${yoctoToNear(cost)} NEAR from ${OPERATOR_ACCOUNT_ID}, once. Re-run with --yes to deploy.`);
    return;
  }

  // Each step is skipped when an earlier run already did it, so an interrupted run can be repeated.
  const operator = operatorAccount();
  // During setup the factory takes the operator's key; it then makes the operator its owner and drops the key.
  const operatorKey = KeyPair.fromString(OPERATOR_PRIVATE_KEY).getPublicKey();
  if (!(await accountExists(factoryId))) {
    console.log("Creating the factory account...");
    await operator.signAndSendTransaction({
      receiverId: factoryId,
      actions: [actions.createAccount(), actions.transfer(FACTORY_FUNDING), actions.addFullAccessKey(operatorKey)],
    });
  }
  const owner = await view(factoryId, "get_owner").catch(() => null);
  if (owner !== OPERATOR_ACCOUNT_ID) {
    console.log("Deploying the factory, making the operator its owner, and removing its key...");
    await signingAccount(factoryId, OPERATOR_PRIVATE_KEY).signAndSendTransaction({
      receiverId: factoryId,
      actions: [
        ...(owner ? [] : [actions.deployContract(factoryCode), actions.functionCall("new", {}, 50n * TGAS)]),
        actions.functionCall("set_owner", { owner_id: OPERATOR_ACCOUNT_ID }, 20n * TGAS),
        actions.deleteKey(operatorKey),
      ],
    });
  }

  console.log("Storing the DAO code and publishing it as a global contract...");
  try {
    await operator.signAndSendTransaction({
      receiverId: factoryId,
      actions: [actions.functionCall("store", daoCode, 300n * TGAS, storeDeposit(daoCode))],
    });
  } catch (err) {
    if (!/ERR_ALREADY_EXISTS/.test(err.message)) throw err;
  }
  const codeHash = daoHash;
  await operator.callFunction({
    contractId: factoryId,
    methodName: "store_contract_metadata",
    args: { code_hash: codeHash, metadata: { version: [3, 2], commit_id: SPUTNIK_REV, changelog_url: null }, set_default: true },
    gas: 50n * TGAS,
  });

  // Views read final blocks, a couple of blocks behind the transaction.
  let ready = null;
  for (let tries = 0; tries < 20 && ready !== codeHash; tries++) {
    if (tries) await new Promise((r) => setTimeout(r, 1000));
    ready = await view(factoryId, "get_default_code_hash").catch(() => null);
  }
  if (ready !== codeHash) throw new Error(`${factoryId} didn't take ${codeHash} as its default`);
  console.log(`\n${factoryId} is ready: new DAOs use ${codeHash} (Sputnik 3.2), owned by ${await view(factoryId, "get_owner")}.`);
  console.log(`\nSet in .env, then restart the bot:\n  SPUTNIK_FACTORY_ID=${factoryId}\n  DAO_CREATE_DEPOSIT=0.1`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
