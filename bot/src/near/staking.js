import { nearToYocto } from "near-api-js";
import { view, call, callWithOutcome } from "./client.js";

/**
 * A DAO's staking contract (orbits/orbit-staking) and its NEP-141 token.
 * Stake is what every stake-based model counts, read by snapshot.
 */

const ONE_YOCTO = 1n;
/** Registers a member on the staking contract and pays for their stake history. */
const STAKING_STORAGE = nearToYocto("0.01");
/** Below this, a member's staking storage balance is topped up before staking. */
const MIN_STAKING_STORAGE = nearToYocto("0.002");
/** NEP-145 registration on the token, so it can hold an account's balance. */
const TOKEN_STORAGE = nearToYocto("0.00125");

// --- Token ---

export const tokenMetadata = (tokenId) => view(tokenId, "ft_metadata");
export const totalSupply = async (tokenId) => BigInt(await view(tokenId, "ft_total_supply"));
export const tokenBalance = async (tokenId, accountId) => BigInt(await view(tokenId, "ft_balance_of", { account_id: accountId }));

/** Registers `accountId` on the token if it isn't yet, paid by `account`. */
export async function ensureTokenStorage(account, tokenId, accountId = account.accountId) {
  if (await view(tokenId, "storage_balance_of", { account_id: accountId })) return;
  await call(account, tokenId, "storage_deposit", { account_id: accountId, registration_only: true }, { deposit: TOKEN_STORAGE });
}

/** Sends `amount` token units to `receiverId`, registering them on the token first. */
/** Sends `amount` token units to `receiverId`, registering them with the token first; returns the transaction's hash. */
export async function sendToken(account, tokenId, receiverId, amount) {
  await ensureTokenStorage(account, tokenId, receiverId);
  const outcome = await callWithOutcome(account, tokenId, "ft_transfer", { receiver_id: receiverId, amount: String(amount) }, { deposit: ONE_YOCTO });
  return outcome.transaction?.hash;
}

// --- Staking ---

/** The member's stake, locked and available amounts, or null if they never registered. */
export async function getMember(stakingId, accountId) {
  const m = await view(stakingId, "get_member", { account_id: accountId });
  return m ? { stake: BigInt(m.stake), locked: BigInt(m.locked), available: BigInt(m.available), storage: BigInt(m.storage_balance) } : null;
}

export const totalStaked = async (stakingId) => BigInt(await view(stakingId, "total_staked"));

/** Stakes `amount` token units: registers (or tops up storage) first, then transfers the tokens in. */
export async function stake(account, tokenId, stakingId, amount) {
  const member = await getMember(stakingId, account.accountId);
  if (!member || member.storage < MIN_STAKING_STORAGE) {
    await call(account, stakingId, "storage_deposit", {}, { deposit: STAKING_STORAGE });
  }
  await call(account, tokenId, "ft_transfer_call", { receiver_id: stakingId, amount: String(amount), msg: "" }, { deposit: ONE_YOCTO });
}

/** Returns `amount` of unlocked stake to the member at once. */
export function unstake(account, stakingId, amount) {
  return call(account, stakingId, "unstake", { amount: String(amount) }, { deposit: ONE_YOCTO });
}
