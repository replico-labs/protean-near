// Publishes the Orbits contracts once as NEAR global contracts, by code hash,
// and records their hashes in orbits/deployments/<network>.json. Every DAO
// then uses them by hash (scripts/deploy-dao.js) and stores no code of its own.
//
//   node scripts/publish-contracts.js          # shows what it would publish and the cost
//   node scripts/publish-contracts.js --yes    # publishes, paid by NEAR_OPERATOR_ACCOUNT_ID
//   node scripts/publish-contracts.js tokenWeighted quadratic --yes
//                                              # only these models' modules (plus staking
//                                              # and the token); add the rest later
//
// Code published by hash can never change: a fixed version that DAOs opt
// into. A new version is a new hash, published alongside the old one.
// Run `cargo near build non-reproducible-wasm` in each contract first.
// Set NEAR_RPC_URL to publish on a local sandbox.
import "../src/logRedaction.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { actions, baseEncode, yoctoToNear } from "near-api-js";
import { NETWORK_ID, OPERATOR_ACCOUNT_ID } from "../src/config.js";
import { operatorAccount, provider } from "../src/near/client.js";
import { MODULE_CONTRACT } from "../src/near/models.js";

export const CONTRACTS = [...Object.values(MODULE_CONTRACT), "orbit_staking", "governance_token"];
const WASM_DIR = new URL("../../orbits/target/near/", import.meta.url);
const DEPLOYMENTS_DIR = new URL("../../orbits/deployments/", import.meta.url);
// Publishing a global contract costs 10x normal storage (1 NEAR per 100 kB).
const GLOBAL_COST_PER_BYTE = 10n ** 20n;

async function isPublished(hash) {
  try {
    await provider.viewGlobalContractCode({ identifier: { codeHash: hash } });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const models = args.filter((a) => a !== "--yes");
  const unknown = models.filter((m) => !MODULE_CONTRACT[m]);
  if (unknown.length) throw new Error(`Unknown model(s): ${unknown.join(", ")}. Models: ${Object.keys(MODULE_CONTRACT).join(", ")}`);
  const selected = models.length ? [...models.map((m) => MODULE_CONTRACT[m]), "orbit_staking", "governance_token"] : CONTRACTS;
  const file = new URL(`${NETWORK_ID}.json`, DEPLOYMENTS_DIR);
  const deployments = existsSync(file) ? JSON.parse(readFileSync(file)) : { network: NETWORK_ID, contracts: {} };

  const todo = [];
  for (const name of selected) {
    const code = readFileSync(new URL(`${name}/${name}.wasm`, WASM_DIR));
    const digest = createHash("sha256").update(code).digest();
    const entry = { codeHash: baseEncode(digest), codeHashHex: digest.toString("hex"), size: code.length };
    const published = await isPublished(entry.codeHash);
    console.log(`${name}: ${entry.codeHash} (${(code.length / 1000).toFixed(1)} kB) ${published ? "already published" : "not published"}`);
    if (published) deployments.contracts[name] = entry;
    else todo.push({ name, code, entry });
  }

  const cost = todo.reduce((sum, t) => sum + BigInt(t.code.length) * GLOBAL_COST_PER_BYTE, 0n);
  if (todo.length && !confirmed) {
    console.log(`\nPublishing ${todo.length} contract(s) costs about ${yoctoToNear(cost)} NEAR from ${OPERATOR_ACCOUNT_ID}, once. Re-run with --yes to publish.`);
    return;
  }
  for (const { name, code, entry } of todo) {
    await operatorAccount().signAndSendTransaction({
      receiverId: OPERATOR_ACCOUNT_ID,
      actions: [actions.deployGlobalContract(code, "codeHash")],
    });
    // Views read final blocks, a couple of blocks behind the transaction.
    let published = false;
    for (let tries = 0; tries < 20 && !published; tries++) {
      if (tries) await new Promise((r) => setTimeout(r, 1000));
      published = await isPublished(entry.codeHash);
    }
    if (!published) throw new Error(`${name} didn't publish`);
    deployments.contracts[name] = entry;
    console.log(`Published ${name}`);
  }

  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(deployments, null, 2) + "\n");
  console.log(`\nRecorded in orbits/deployments/${NETWORK_ID}.json`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
