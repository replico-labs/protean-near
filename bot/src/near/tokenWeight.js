import { nearToYocto } from "near-api-js";
import { view, call } from "./client.js";

/**
 * The token-weight orbit (orbits/token-weight-orbit), its staking contract
 * (Sputnik's sputnik-staking, with the orbit as owner) and its NEP-141 token.
 * Every write takes the signing account.
 */

const ONE_YOCTO = 1n;
/** Covers a proposal's storage on the orbit; the orbit refunds what's left. */
const PROPOSAL_DEPOSIT = nearToYocto("0.01");
/** Registers a user on the staking contract, with room for their delegation. */
const STAKING_STORAGE = nearToYocto("0.01");
/** NEP-145 registration on the token, so it can hold the user's balance. */
const TOKEN_STORAGE = nearToYocto("0.00125");

// --- Orbit ---

export const getConfig = (orbitId) => view(orbitId, "get_config");
export const getDao = (orbitId) => view(orbitId, "get_dao");
export const getStakingContract = (orbitId) => view(orbitId, "get_staking_contract");
export const getToken = (orbitId) => view(orbitId, "get_token");
export const getThreshold = async (orbitId) => BigInt(await view(orbitId, "get_threshold"));
export const getProposalCount = (orbitId) => view(orbitId, "get_proposal_count");
export const getProposal = (orbitId, id) => view(orbitId, "get_proposal", { id: Number(id) });
export const getProposals = (orbitId, fromIndex, limit) => view(orbitId, "get_proposals", { from_index: fromIndex, limit });
export const getVote = (orbitId, id, accountId) => view(orbitId, "get_vote", { id: Number(id), account_id: accountId });
export const weightOf = async (orbitId, accountId) => BigInt(await view(orbitId, "delegation_balance_of", { account_id: accountId }));
export const totalWeight = async (orbitId) => BigInt(await view(orbitId, "delegation_total_supply"));

/** Proposes `kind` (a Sputnik proposal kind object). Returns the new proposal id. */
export function propose(account, orbitId, description, kind) {
  return call(account, orbitId, "propose", { description, kind: JSON.stringify(kind) }, { deposit: PROPOSAL_DEPOSIT });
}

/** Votes "Approve" or "Reject". Returns the proposal's new status. */
export function vote(account, orbitId, id, choice) {
  return call(account, orbitId, "vote", { id: Number(id), choice });
}

/** Sends a passed proposal to the core. */
export function execute(account, orbitId, id) {
  return call(account, orbitId, "execute", { id: Number(id) });
}

/** Marks a proposal whose voting period is over as expired. */
export function finalize(account, orbitId, id) {
  return call(account, orbitId, "finalize", { id: Number(id) });
}

// --- Token ---

export const tokenMetadata = (tokenId) => view(tokenId, "ft_metadata");
export const tokenBalance = async (tokenId, accountId) => BigInt(await view(tokenId, "ft_balance_of", { account_id: accountId }));

/** Registers `accountId` on the token if it isn't yet (NEP-145), paid by `account`. */
export async function ensureTokenStorage(account, tokenId, accountId = account.accountId) {
  const balance = await view(tokenId, "storage_balance_of", { account_id: accountId });
  if (balance) return;
  await call(account, tokenId, "storage_deposit", { account_id: accountId, registration_only: true }, { deposit: TOKEN_STORAGE });
}

// --- Staking ---

/** The user's record on the staking contract, or null if they never staked. */
export async function stakingUser(stakingId, accountId) {
  try {
    return await view(stakingId, "get_user", { account_id: accountId });
  } catch (err) {
    if (/NO_USER/.test(err?.message)) return null;
    throw err;
  }
}

/**
 * Stakes `amount` token units and delegates them to the staker, so they
 * count as the staker's voting weight: register on the staking contract
 * (first time only), transfer the tokens in, then delegate.
 */
export async function stake(account, tokenId, stakingId, amount) {
  if (!(await stakingUser(stakingId, account.accountId))) {
    await call(account, stakingId, "storage_deposit", { account_id: account.accountId }, { deposit: STAKING_STORAGE });
  }
  await call(account, tokenId, "ft_transfer_call", { receiver_id: stakingId, amount: String(amount), msg: "" }, { deposit: ONE_YOCTO });
  await call(account, stakingId, "delegate", { account_id: account.accountId, amount: String(amount) });
}

/**
 * Takes `amount` of the staker's own delegation back. The tokens stay
 * locked on the staking contract for its unstake period, then `withdraw`
 * returns them.
 */
export function unstake(account, stakingId, amount) {
  return call(account, stakingId, "undelegate", { account_id: account.accountId, amount: String(amount) });
}

/** Returns `amount` of unlocked, undelegated tokens to the user. */
export function withdraw(account, stakingId, amount) {
  return call(account, stakingId, "withdraw", { amount: String(amount) });
}
