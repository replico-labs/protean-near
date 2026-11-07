import { readFileSync, existsSync } from "node:fs";
import { actions, nearToYocto, yoctoToNear } from "near-api-js";
import { SPUTNIK_FACTORY_ID, OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY, NETWORK_ID } from "../config.js";
import { operatorAccount, signingAccount, accountExists, availableBalance, view, call } from "./client.js";
import { modelConfig, orbitPolicy, ORBIT_PREFIX, MODULE_CONTRACT, isCouncilModel, takesMembers } from "./models.js";

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
 *   tw.ark.orbits.testnet          orbit: the model's module (prefix by model)
 *   guard.ark.orbits.testnet       a guard, if the DAO turns one on
 *   token2, staking2, migrator2    after a token change: the new token, its
 *                                  staking vault, and the migrator from the old
 */

const TGAS = 1_000_000_000_000n;
const TOKEN_STORAGE = nearToYocto("0.00125");
// NEAR for each account's own state; code is shared, so it costs nothing here.
// A guard pays for the instructions it stores.
const FUNDING = { token: nearToYocto("0.05"), staking: nearToYocto("0.1"), orbit: nearToYocto("0.2"), guard: nearToYocto("0.5"), migrator: nearToYocto("0.05") };
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
export function publishedContracts(model, extra = []) {
  const file = new URL(`../../../orbits/deployments/${NETWORK_ID}.json`, import.meta.url);
  const contracts = existsSync(file) ? JSON.parse(readFileSync(file)).contracts : {};
  const needed = ["orbit_staking", "governance_token", MODULE_CONTRACT[model], ...extra].filter(Boolean);
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

/** Seats for `model`'s orbit: a board's members, or a council of at least 3. */
const seats = (model, council) => (model === "board" ? council.length : isCouncilModel(model) ? Math.max(3, council.length) : 0);

/** The orbit's `new` arguments. `supply` scales its thresholds: the token's cap. */
const orbitArgs = ({ daoId, stakingId, tokenId, model, supply, council }) => ({
  dao_id: daoId,
  staking_id: stakingId,
  token_id: tokenId,
  model: modelConfig(model, supply, seats(model, council)),
  council: takesMembers(model) ? council : null,
});

/** `prefix.base`, or `prefix2.base`, `prefix3.base`... whichever is free first. */
async function freeName(prefix, base) {
  let id = `${prefix}.${base}`;
  for (let n = 2; await accountExists(id); n++) id = `${prefix}${n}.${base}`;
  return id;
}

/** The namespace, topped up to create an account funded with `amount`. */
async function fundedNamespace(name, amount) {
  const base = `${name}.${OPERATOR_ACCOUNT_ID}`;
  const parent = await namespace(base);
  await operatorAccount().transfer({ receiverId: base, amount: amount + nearToYocto("0.05") });
  if ((await availableBalance(base)) < amount + GAS_RESERVE) await operatorAccount().transfer({ receiverId: base, amount: GAS_RESERVE });
  return { base, parent };
}

/** Creates an orbit for `daoId` running `model`, with a unique name. */
export async function createOrbit({ name, daoId, tokenId, stakingId, model, supply, council = [] }) {
  const contracts = publishedContracts(model);
  const { base, parent } = await fundedNamespace(name, FUNDING.orbit);
  const orbitId = await freeName(ORBIT_PREFIX[model], base);
  await createContract(parent, orbitId, contracts[MODULE_CONTRACT[model]].codeHashHex, FUNDING.orbit, orbitArgs({ daoId, stakingId, tokenId, model, supply, council }));
  await registerWithToken(tokenId, orbitId);
  return orbitId;
}

/**
 * Creates a guard for `daoId` answering to `governance` (the orbit): the
 * DAO turns it on by handing the core to it. Periods in nanoseconds.
 */
export async function createGuard({ name, daoId, governance, signers, threshold, tenureNs, ttlNs }) {
  const contracts = publishedContracts(null, ["orbit_guard"]);
  const { base, parent } = await fundedNamespace(name, FUNDING.guard);
  const guardId = await freeName("guard", base);
  await createContract(parent, guardId, contracts.orbit_guard.codeHashHex, FUNDING.guard, {
    dao_id: daoId,
    governance,
    signers,
    threshold,
    tenure_length: String(tenureNs),
    instruction_ttl: String(ttlNs),
  });
  return guardId;
}

/**
 * Prepares a token change for `daoId`: a new token (its whole initial
 * supply, the old supply times numerator/denominator, minted to the
 * migrator), its staking vault, the migrator, and an orbit running `model`
 * on the new token. The DAO switches by handing the core to the orbit.
 */
export async function createTokenChange({ name, daoId, oldTokenId, symbol, numerator, denominator, cap = null, decimals = 18, model, council = [], onStep = () => {} }) {
  const contracts = publishedContracts(model, ["orbit_migrator"]);
  const total = FUNDING.token + FUNDING.staking + FUNDING.migrator + FUNDING.orbit;
  const { base, parent } = await fundedNamespace(name, total);
  const oldSupply = BigInt(await view(oldTokenId, "ft_total_supply"));
  const supply = (oldSupply / denominator) * numerator + ((oldSupply % denominator) * numerator) / denominator;
  if (cap !== null && cap < supply) throw new Error(`The cap must cover the ${supply} new tokens the old supply swaps for`);
  // Matching numbers: token2, staking2, migrator2.
  let n = 2;
  while ((await accountExists(`token${n}.${base}`)) || (await accountExists(`staking${n}.${base}`)) || (await accountExists(`migrator${n}.${base}`))) n++;
  const ids = { tokenId: `token${n}.${base}`, stakingId: `staking${n}.${base}`, migratorId: `migrator${n}.${base}` };

  onStep("Creating the new token, its staking vault and the migrator");
  await createContract(parent, ids.tokenId, contracts.governance_token.codeHashHex, FUNDING.token, {
    owner_id: ids.migratorId,
    total_supply: String(supply),
    name,
    symbol,
    decimals,
    max_supply: cap === null ? null : String(cap),
    minter: daoId,
  });
  await createContract(parent, ids.stakingId, contracts.orbit_staking.codeHashHex, FUNDING.staking, { dao_id: daoId, token_id: ids.tokenId });
  await createContract(parent, ids.migratorId, contracts.orbit_migrator.codeHashHex, FUNDING.migrator, {
    dao_id: daoId,
    old_token: oldTokenId,
    new_token: ids.tokenId,
    new_vault: ids.stakingId,
    numerator: String(numerator),
    denominator: String(denominator),
  });
  for (const accountId of [ids.stakingId, daoId]) await registerWithToken(ids.tokenId, accountId);
  // The migrator receives the old token from holders.
  await registerWithToken(oldTokenId, ids.migratorId).catch(() => {});

  onStep("Creating the orbit on the new token");
  const orbitId = await freeName(ORBIT_PREFIX[model], base);
  await createContract(parent, orbitId, contracts[MODULE_CONTRACT[model]].codeHashHex, FUNDING.orbit, orbitArgs({ daoId, stakingId: ids.stakingId, tokenId: ids.tokenId, model, supply: cap ?? supply, council }));
  await registerWithToken(ids.tokenId, orbitId);
  return { ...ids, orbitId, supply };
}

/**
 * Registers `accountId` with the DAO's token, paid by the operator. The
 * orbit receives tokens (challenge bonds, Sowellian bonds and bets, market
 * seeds), which the token refuses for an account it doesn't know.
 */
async function registerWithToken(tokenId, accountId) {
  await call(operatorAccount(), tokenId, "storage_deposit", { account_id: accountId, registration_only: true }, { deposit: TOKEN_STORAGE });
}

/**
 * Creates a complete DAO: the core, a token with `supply` (raw units) all
 * held by `holder`, the staking contract, and an orbit running `model`
 * (a board's or council's members in `council`). With `cap`, the DAO can
 * later mint up to it in all; without, the supply is fixed. `onStep`
 * reports progress.
 */
export async function createDao({ name, symbol, supply, cap = null, decimals = 18, model, council = [], holder, onStep = () => {} }) {
  const contracts = publishedContracts(model);
  const ids = daoAccounts(name);
  if (ids.base === SPUTNIK_FACTORY_ID) throw new Error(`${name} is the factory's own name - pick another name`);
  if (await accountExists(ids.dao)) throw new Error(`${ids.dao} already exists - pick another name`);
  const operator = operatorAccount();
  const parent = await namespace(ids.base);

  // The orbit's name is fixed before anything exists, so the core can name it as its member.
  const orbitId = `${ORBIT_PREFIX[model]}.${ids.base}`;
  const policy = orbitPolicy(orbitId);
  const args = Buffer.from(JSON.stringify({ config: { name, purpose: `${name}, governed by Orbits (${model})`, metadata: "" }, policy })).toString("base64");
  onStep("Creating the DAO on Sputnik");
  try {
    await operator.callFunction({ contractId: SPUTNIK_FACTORY_ID, methodName: "create", args: { name, args }, deposit: DAO_DEPOSIT(), gas: 300n * TGAS });
  } catch (err) {
    // A factory without global contracts deploys the whole DAO contract per DAO and says how much that takes.
    const needed = /ERR_?NOT_?ENOUGH_?DEPOSIT:(\d+)/i.exec(String(err.message).replace(/\s/g, ""))?.[1];
    if (needed) throw new Error(`${SPUTNIK_FACTORY_ID} needs ${Math.ceil(Number(yoctoToNear(needed)))} NEAR to create a DAO: set DAO_CREATE_DEPOSIT=${Math.ceil(Number(yoctoToNear(needed)))} in the bot's .env and restart it. What isn't used starts the treasury.`);
    throw err;
  }
  if (!(await accountExists(ids.dao))) throw new Error(`Sputnik's factory didn't create ${ids.dao}. An older factory needs more NEAR: set DAO_CREATE_DEPOSIT (e.g. 6).`);

  onStep("Creating the token and staking contract");
  await createContract(parent, ids.token, contracts.governance_token.codeHashHex, FUNDING.token, {
    owner_id: holder,
    total_supply: String(supply),
    name,
    symbol,
    decimals,
    max_supply: cap === null ? null : String(cap),
    // Only a passed proposal mints, and only up to the cap.
    minter: cap === null ? null : ids.dao,
  });
  await createContract(parent, ids.staking, contracts.orbit_staking.codeHashHex, FUNDING.staking, { dao_id: ids.dao, token_id: ids.token });
  for (const accountId of [ids.staking, ids.dao]) {
    await call(operator, ids.token, "storage_deposit", { account_id: accountId, registration_only: true }, { deposit: TOKEN_STORAGE });
  }

  onStep("Creating the governance orbit");
  await createContract(parent, orbitId, contracts[MODULE_CONTRACT[model]].codeHashHex, FUNDING.orbit, orbitArgs({ daoId: ids.dao, stakingId: ids.staking, tokenId: ids.token, model, supply: cap ?? supply, council }));
  await registerWithToken(ids.token, orbitId);
  if (model === "conviction") await call(operator, orbitId, "claim_locker");
  const governing = (await view(ids.dao, "get_policy")).roles.find((r) => r.name === "governance").kind.Group;
  if (JSON.stringify(governing) !== JSON.stringify([orbitId])) throw new Error(`Unexpected governance members on ${ids.dao}: ${governing}`);
  return { daoId: ids.dao, orbitId, tokenId: ids.token, stakingId: ids.staking, model };
}
