import { provider, view } from "./client.js";
import { publishedContracts } from "./deploy.js";

/**
 * Telling contracts from before guards, token changes and capped tokens
 * apart from today's. DAOs created then keep running that code: global
 * contracts can't be updated in place.
 *
 * - An orbit from before has no `get_binding` and doesn't know how to send
 *   through a guard: behind one, nothing it passes could ever run again.
 * - A staking vault from before can't hand its locker to an orbit behind a
 *   guard, which conviction voting needs.
 * - A token from before has a fixed supply and no cap.
 */

/** The code hashes published on testnet before them (October 2026). */
export const BEFORE_GUARDS = {
  orbit_staking: "5VuyqRFFsrwbMByjVR9CVNCwPqdAKdZHu4mZoJuhhxcj",
  governance_token: "E7sPCuzLdZhno4Y1mEKXnwHeGXcVX3mzScCcy8LAdUBV",
};

const MISSING_METHOD = /MethodNotFound|MethodResolveError|method.*not found/i;

/** Whether the orbit can sit behind a guard (it has `get_binding`). */
export async function orbitKnowsGuards(orbitId) {
  try {
    await view(orbitId, "get_binding");
    return true;
  } catch (err) {
    if (MISSING_METHOD.test(String(err?.message ?? err))) return false;
    throw err;
  }
}

/** The code hash an account runs: its global contract's, or its own. */
export async function codeHashOf(accountId) {
  const account = await provider.viewAccount({ accountId });
  return account.global_contract_hash ?? account.code_hash;
}

/** Whether a staking vault runs the code from before guards. */
export const isOldVault = async (stakingId) => (await codeHashOf(stakingId)) === BEFORE_GUARDS.orbit_staking;

/** Whether new tokens get today's code, which takes a cap. */
export const publishedTokenTakesCaps = () => publishedContracts(null).governance_token.codeHash !== BEFORE_GUARDS.governance_token;
