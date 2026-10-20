import { readFileSync, existsSync } from "node:fs";
import { actions, nearToYocto } from "near-api-js";
import { SPUTNIK_FACTORY_ID, OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY, NETWORK_ID } from "../config.js";
import { operatorAccount, signingAccount, accountExists, availableBalance, view, call } from "./client.js";
import { modelConfig, boardPolicy, orbitPolicy, ORBIT_PREFIX, MODULE_CONTRACT, isCouncilModel } from "./models.js";

/**
 * Creates DAOs and orbits from the contracts published once as global
 * contracts (scripts/publish-contracts.js). Each account uses the shared
 * code by hash and stores none of its own; contract accounts get no access
 * key, so nobody can change them. The operator pays.
 *
 * A DAO "ark" on testnet, operator orbits.testnet:
 *   ark.sputnikv2.testnet          core (official Sputnik factory)
 *   ark.orbits.testnet             namespace, holds the operator's key
 *   token.ark.orbits.testnet       governance token
 *   staking.ark.orbits.testnet     staking, owned by the core
 *   tw.ark.orbits.testnet          orbit: the model's module (prefix by model; none for a board)
 */

const TGAS = 1_000_000_000_000n;
const TOKEN_STORAGE = nearToYocto("0.00125");
// NEAR for each account's own state; code is shared, so it costs nothing here.
const FUNDING = { token: nearToYocto("0.05"), staking: nearToYocto("0.1"), orbit: nearToYocto("0.2") };
// The namespace signs each creation, and a transaction needs its gas up front
// (about 0.1 NEAR for 100 Tgas) on top of the funding; what isn't used comes back.
const GAS_RESERVE = nearToYocto("0.15");
// Sputnik's factory (3.2+, global contracts) needs 0.01 NEAR; the rest starts the treasury.
const DAO_DEPOSIT = () => nearToYocto(process.env.DAO_CREATE_DEPOSIT || "0.1");

/**
 * Code hashes of the published contracts on this network, checking that
 * the ones a DAO running `model` needs are there: the token, staking, and
 * the model's module.
 */
export function publishedContracts(model) {
  const file = new URL(`../../../orbits/deployments/${NETWORK_ID}.json`, import.meta.url);
  const contracts = existsSync(file) ? JSON.parse(readFileSync(file)).contracts : {};
  const needed = ["orbit_staking", "governance_token", MODULE_CONTRACT[model]].filter(Boolean);
  for (const name of needed) {
    if (!contracts[name]) throw new Error(`${name} isn't published on ${NETWORK_ID} yet. Run: node scripts/publish-contracts.js --yes`);
  }
  return contracts;
}

/** The account names a DAO called `name` gets. */
export function daoAccounts(name) {
  const base = `${name}.${OPERATOR_ACCOUNT_ID}`;
  return { base, dao: `${name}.${SPUTNIK_FACTORY_ID}`, token: `token.${base}`, staking: `staking.${base}` };
}

/** Creates `accountId` under `signer`, funds it, points it at global contract `codeHashHex` and initializes it, in one transaction. */
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
}

/** The namespace account for a DAO's contracts, created if needed, signing with the operator's key. */
async function namespace(base) {
  if (!(await accountExists(base))) {
    const operator = operatorAccount();
    const total = FUNDING.token + FUNDING.staking + FUNDING.orbit + GAS_RESERVE + nearToYocto("0.1");
    await operator.createSubAccount({ accountOrPrefix: base, publicKey: await operator.getSigner().getPublicKey(), nearToTransfer: total });
  }
  return signingAccount(base, OPERATOR_PRIVATE_KEY);
}

/** Creates an orbit for `daoId` running `model`, with a unique name. */
export async function createOrbit({ name, daoId, tokenId, stakingId, model, supply, council = [] }) {
  const contracts = publishedContracts(model);
  const base = `${name}.${OPERATOR_ACCOUNT_ID}`;
  const parent = await namespace(base);
  // The namespace pays for the new account; top it up for this one.
  await operatorAccount().transfer({ receiverId: base, amount: FUNDING.orbit + nearToYocto("0.05") });
  if ((await availableBalance(base)) < FUNDING.orbit + GAS_RESERVE) await operatorAccount().transfer({ receiverId: base, amount: GAS_RESERVE });
  let orbitId = `${ORBIT_PREFIX[model]}.${base}`;
  for (let n = 2; await accountExists(orbitId); n++) orbitId = `${ORBIT_PREFIX[model]}${n}.${base}`;
  const size = isCouncilModel(model) ? Math.max(3, council.length) : 0;
  await createContract(parent, orbitId, contracts[MODULE_CONTRACT[model]].codeHashHex, FUNDING.orbit, {
    dao_id: daoId,
    staking_id: stakingId,
    token_id: tokenId,
    model: modelConfig(model, supply, size),
    council: isCouncilModel(model) ? council : null,
  });
  return orbitId;
}

/**
 * Creates a complete DAO: the core, a token with `supply` (raw units) all
 * held by `holder`, the staking contract, and an orbit running `model`, or
 * for a board, `council` as the core's members. `onStep` reports progress.
 */
export async function createDao({ name, symbol, supply, decimals = 18, model, council = [], holder, onStep = () => {} }) {
  const contracts = publishedContracts(model);
  const ids = daoAccounts(name);
  if (await accountExists(ids.dao)) throw new Error(`${ids.dao} already exists - pick another name`);
  const operator = operatorAccount();
  const parent = await namespace(ids.base);

  // The orbit's name is fixed before anything exists, so the core can name it as its member.
  const orbitId = model === "board" ? null : `${ORBIT_PREFIX[model]}.${ids.base}`;
  const policy = model === "board" ? boardPolicy(council) : orbitPolicy(orbitId);
  const args = Buffer.from(JSON.stringify({ config: { name, purpose: `${name}, governed by Orbits (${model})`, metadata: "" }, policy })).toString("base64");
  onStep("Creating the DAO on Sputnik");
  await operator.callFunction({ contractId: SPUTNIK_FACTORY_ID, methodName: "create", args: { name, args }, deposit: DAO_DEPOSIT(), gas: 300n * TGAS });
  if (!(await accountExists(ids.dao))) throw new Error(`Sputnik's factory didn't create ${ids.dao}. An older factory needs more NEAR: set DAO_CREATE_DEPOSIT (e.g. 6).`);

  onStep("Creating the token and staking contract");
  await createContract(parent, ids.token, contracts.governance_token.codeHashHex, FUNDING.token, { owner_id: holder, total_supply: String(supply), name, symbol, decimals });
  await createContract(parent, ids.staking, contracts.orbit_staking.codeHashHex, FUNDING.staking, { dao_id: ids.dao, token_id: ids.token });
  for (const accountId of [ids.staking, ids.dao]) {
    await call(operator, ids.token, "storage_deposit", { account_id: accountId, registration_only: true }, { deposit: TOKEN_STORAGE });
  }

  if (orbitId) {
    onStep("Creating the governance orbit");
    const size = isCouncilModel(model) ? Math.max(3, council.length) : 0;
    await createContract(parent, orbitId, contracts[MODULE_CONTRACT[model]].codeHashHex, FUNDING.orbit, {
      dao_id: ids.dao,
      staking_id: ids.staking,
      token_id: ids.token,
      model: modelConfig(model, supply, size),
      council: isCouncilModel(model) ? council : null,
    });
    if (model === "conviction") await call(operator, orbitId, "claim_locker");
  }
  const governing = (await view(ids.dao, "get_policy")).roles.find((r) => r.name === "governance").kind.Group;
  const expected = orbitId ? [orbitId] : council;
  if (JSON.stringify([...governing].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`Unexpected governance members on ${ids.dao}: ${governing}`);
  return { daoId: ids.dao, orbitId, tokenId: ids.token, stakingId: ids.staking, model };
}
