// Creates a complete Orbits DAO on NEAR: the Sputnik core, a governance token,
// Sputnik's staking contract and a token-weight orbit, wired together.
//
//   node scripts/deploy-dao.js <name> <SYMBOL> <totalSupply> [--voting-hours 24] [--owner <account>]
//
// Signs as NEAR_OPERATOR_ACCOUNT_ID (.env). The contracts are the global
// contracts published by scripts/publish-contracts.js: each account here
// uses them by code hash and stores no code, only its own state. Every
// contract account is created with no access key, so nobody, the operator
// included, can change it.
import "../src/logRedaction.js";
import { readFileSync, existsSync } from "node:fs";
import { actions, nearToYocto } from "near-api-js";
import { SPUTNIK_FACTORY_ID, OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY, EXPLORER_URL, NETWORK_ID } from "../src/config.js";
import { operatorAccount, signingAccount, accountExists, view } from "../src/near/client.js";
import { toUnits } from "../src/near/amounts.js";

const TGAS = 1_000_000_000_000n;

// NEAR for each account's own state (code is shared, so it costs nothing
// here), with room to grow: holders on the token, votes on the orbit, and
// the staking contract pays each new staker's registration on the orbit.
const FUNDING = { token: nearToYocto("0.05"), staking: nearToYocto("0.1"), orbit: nearToYocto("0.1") };
// Sputnik's factory (3.2+, global contracts) needs 0.01 NEAR; the rest stays in the treasury.
const DAO_DEPOSIT = process.env.DAO_CREATE_DEPOSIT || "0.1";

/** Code hashes of the published contracts (scripts/publish-contracts.js). */
function publishedContracts() {
  const file = new URL(`../../orbits/deployments/${NETWORK_ID}.json`, import.meta.url);
  const contracts = existsSync(file) ? JSON.parse(readFileSync(file)).contracts : {};
  for (const name of ["governance_token", "sputnik_staking", "token_weight_orbit"]) {
    if (!contracts[name]) throw new Error(`${name} isn't published on ${NETWORK_ID} yet. Run: node scripts/publish-contracts.js`);
  }
  return contracts;
}

function parseArgs(argv) {
  const [name, symbol, supply, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];
  if (!name || !/^[a-z0-9-]{2,30}$/.test(name) || !symbol || !supply) {
    console.error("Usage: node scripts/deploy-dao.js <name> <SYMBOL> <totalSupply> [--voting-hours 24] [--owner <account>] [--decimals 18]");
    process.exit(1);
  }
  return { name, symbol, supply, votingHours: Number(flags["voting-hours"] ?? 24), owner: flags.owner ?? OPERATOR_ACCOUNT_ID, decimals: Number(flags.decimals ?? 18) };
}

/**
 * Creates `accountId` (a sub-account of the signer), funds it, points it at
 * the global contract `codeHashHex` and calls `new`, all in one transaction.
 */
async function createContract(signer, accountId, codeHashHex, near, initArgs) {
  if (await accountExists(accountId)) throw new Error(`${accountId} already exists`);
  await signer.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      actions.createAccount(),
      actions.transfer(near),
      actions.useGlobalContract({ codeHash: codeHashHex }),
      actions.functionCall("new", initArgs, 100n * TGAS, 0n),
    ],
  });
  console.log(`  ${accountId}`);
}

async function main() {
  const { name, symbol, supply, votingHours, owner, decimals } = parseArgs(process.argv.slice(2));
  const totalSupply = toUnits(supply, decimals);
  if (!totalSupply) throw new Error(`Bad supply ${supply}`);
  const operator = operatorAccount();
  const base = `${name}.${OPERATOR_ACCOUNT_ID}`;
  const ids = { dao: `${name}.${SPUTNIK_FACTORY_ID}`, token: `token.${base}`, staking: `staking.${base}`, orbit: `tw.${base}` };
  const votingPeriod = BigInt(votingHours) * 3_600_000_000_000n;
  // Undelegated tokens stay locked longer than any vote, so a stake can't vote twice.
  const unstakePeriod = votingPeriod + 3_600_000_000_000n;

  console.log(`Creating ${name} on ${NETWORK_ID}...`);
  if (await accountExists(ids.dao)) throw new Error(`${ids.dao} already exists`);

  const contracts = publishedContracts();
  const contractsCost = Object.values(FUNDING).reduce((sum, n) => sum + n, 0n);

  // A namespace account for the contracts, signed by the operator's key.
  if (!(await accountExists(base))) {
    await operator.createSubAccount({ accountOrPrefix: base, publicKey: await operator.getSigner().getPublicKey(), nearToTransfer: contractsCost + nearToYocto("0.1") });
  }
  const parent = signingAccount(base, OPERATOR_PRIVATE_KEY);

  // 1. The core: a Sputnik DAO whose only member is the orbit.
  const policy = {
    roles: [{ name: "governance", kind: { Group: [ids.orbit] }, permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], vote_policy: {} }],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] },
    proposal_bond: "0",
    proposal_period: "604800000000000",
    bounty_bond: "0",
    bounty_forgiveness_period: "86400000000000",
  };
  const args = Buffer.from(JSON.stringify({ config: { name, purpose: `${name}, governed by Orbits`, metadata: "" }, policy })).toString("base64");
  await operator.callFunction({ contractId: SPUTNIK_FACTORY_ID, methodName: "create", args: { name, args }, deposit: nearToYocto(DAO_DEPOSIT), gas: 300n * TGAS });
  if (!(await accountExists(ids.dao))) throw new Error(`The factory didn't create ${ids.dao}. An older factory needs more NEAR: set DAO_CREATE_DEPOSIT (e.g. 6).`);
  console.log(`  ${ids.dao}`);

  // 2. Token, staking contract and orbit.
  await createContract(parent, ids.token, contracts.governance_token.codeHashHex, FUNDING.token, { owner_id: owner, total_supply: String(totalSupply), name, symbol, decimals });
  await createContract(parent, ids.staking, contracts.sputnik_staking.codeHashHex, FUNDING.staking, { owner_id: ids.orbit, token_id: ids.token, unstake_period: String(unstakePeriod) });
  await createContract(parent, ids.orbit, contracts.token_weight_orbit.codeHashHex, FUNDING.orbit, {
    dao_id: ids.dao,
    staking_id: ids.staking,
    token_id: ids.token,
    config: { threshold: [1, 2], quorum: "0", voting_period: String(votingPeriod), min_proposer_weight: "0" },
  });

  // 3. The staking contract and the treasury can hold the token.
  for (const accountId of [ids.staking, ids.dao]) {
    await operator.callFunction({ contractId: ids.token, methodName: "storage_deposit", args: { account_id: accountId, registration_only: true }, deposit: nearToYocto("0.00125"), gas: 30n * TGAS });
  }

  const governing = (await view(ids.dao, "get_policy")).roles.find((r) => r.name === "governance").kind.Group;
  if (governing.length !== 1 || governing[0] !== ids.orbit) throw new Error(`Unexpected governance role: ${governing}`);
  console.log(`\nDone. ${owner} holds all ${supply} ${symbol}.`);
  console.log(`Link a chat:  /link ${ids.dao} ${ids.orbit}`);
  console.log(`Explorer:     ${EXPLORER_URL}/address/${ids.dao}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
