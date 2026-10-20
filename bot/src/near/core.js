import { provider, view } from "./client.js";

/**
 * Reads from a chat's core: an unmodified Sputnik DAO. The bot never writes
 * to it directly; only the orbit can.
 */

export const getPolicy = (daoId) => view(daoId, "get_policy");
export const getConfig = (daoId) => view(daoId, "get_config");
export const getCoreProposal = (daoId, id) => view(daoId, "get_proposal", { id: Number(id) });

/** The orbit(s) that govern the core: members of its "governance" role. */
export async function governingOrbits(daoId) {
  const policy = await getPolicy(daoId);
  const role = policy.roles.find((r) => r.name === "governance");
  return role?.kind?.Group ?? [];
}

/** The treasury's NEAR: the core account's balance, in yoctoNEAR. */
export async function treasuryNear(daoId) {
  const account = await provider.viewAccount({ accountId: daoId });
  return BigInt(account.amount);
}
