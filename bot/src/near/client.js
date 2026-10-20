import { Account, JsonRpcProvider } from "near-api-js";
import { RPC_URL, OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY, MAX_GAS } from "../config.js";

/**
 * The NEAR connection: read-only views, and signed calls from the operator
 * or a user's account.
 */

export const provider = new JsonRpcProvider({ url: RPC_URL });

/** Calls view method `method` on `contractId`; returns the parsed JSON result. */
export function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

/** Whether `accountId` exists on chain. */
export async function accountExists(accountId) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch (err) {
    if (/does not exist|UNKNOWN_ACCOUNT/i.test(String(err?.type ?? "") + err?.message)) return false;
    throw err;
  }
}

/** Available (spendable) NEAR of `accountId`, in yoctoNEAR. */
export async function availableBalance(accountId) {
  return (await new Account(accountId, provider).getState()).balance.available;
}

let operator = null;
/** The operator's account, signing with its key. */
export function operatorAccount() {
  if (!OPERATOR_ACCOUNT_ID || !OPERATOR_PRIVATE_KEY) {
    throw new Error("NEAR_OPERATOR_ACCOUNT_ID and NEAR_OPERATOR_PRIVATE_KEY must be set on this bot instance");
  }
  operator ??= new Account(OPERATOR_ACCOUNT_ID, provider, OPERATOR_PRIVATE_KEY);
  return operator;
}

/** An account signing with `key` ("ed25519:..."). */
export function signingAccount(accountId, key) {
  return new Account(accountId, provider, key);
}

/**
 * Calls `methodName` on `contractId` as `account` and returns the method's
 * parsed result. Throws a ChainError with the contract's own error code
 * (ERR_...) when there is one.
 */
export async function call(account, contractId, methodName, args = {}, { deposit = 0n, gas = MAX_GAS } = {}) {
  try {
    return await account.callFunction({ contractId, methodName, args, deposit, gas });
  } catch (err) {
    throw new ChainError(err);
  }
}

/** A failed call, with the contract's error code (e.g. ERR_ALREADY_VOTED) when it panicked with one. */
export class ChainError extends Error {
  constructor(cause) {
    const text = String(cause?.message ?? cause);
    const code = text.match(/\b(ERR_[A-Z_]+)\b/)?.[1] ?? null;
    super(code ? `${code}${detail(text, code)}` : text.slice(0, 300));
    this.code = code;
    this.cause = cause;
  }
}

/** What follows the error code in the panic message ("ERR_DEPOSIT: attach at least ..."), if anything. */
function detail(text, code) {
  const rest = text.slice(text.indexOf(code) + code.length).match(/^:\s*([^"\n}]+)/)?.[1];
  return rest ? `: ${rest.trim()}` : "";
}
