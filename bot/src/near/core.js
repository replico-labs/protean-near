import { provider, view, call, callWithOutcome, availableBalance } from "./client.js";

/**
 * A chat's core: an unmodified Sputnik DAO. With an orbit, only the orbit
 * writes to it. A board DAO has no orbit: its members propose and vote on
 * the core directly.
 */

export const getPolicy = (daoId) => view(daoId, "get_policy");
export const getConfig = (daoId) => view(daoId, "get_config");
export const getCoreProposal = (daoId, id) => view(daoId, "get_proposal", { id: Number(id) });
export const getCoreProposals = (daoId, fromIndex, limit) => view(daoId, "get_proposals", { from_index: fromIndex, limit });
export const getLastProposalId = (daoId) => view(daoId, "get_last_proposal_id");

/** Members of the core's "governance" role: the orbit, or a board's members. */
export async function governingMembers(daoId) {
  const policy = await getPolicy(daoId);
  const role = policy.roles.find((r) => r.name === "governance");
  return role?.kind?.Group ?? [];
}

/** The treasury's NEAR: the core account's balance, in yoctoNEAR. */
export async function treasuryNear(daoId) {
  const account = await provider.viewAccount({ accountId: daoId });
  return BigInt(account.amount);
}

/** The treasury's spendable NEAR: its balance less what its storage locks. */
export async function availableNear(daoId) {
  return availableBalance(daoId);
}

// --- Board: members act on the core directly ---

/** Adds a proposal to the core, with the policy's bond. Returns its id. */
export async function addProposal(account, daoId, description, kind) {
  const { proposal_bond: bond } = await getPolicy(daoId);
  return call(account, daoId, "add_proposal", { proposal: { description, kind } }, { deposit: BigInt(bond) });
}

/** Votes "VoteApprove" or "VoteReject" on core proposal `id`. */
export async function actProposal(account, daoId, id, action) {
  const proposal = await getCoreProposal(daoId, id);
  return call(account, daoId, "act_proposal", { id: Number(id), action, proposal: proposal.kind });
}

/** Like actProposal, returning the whole outcome: an approval that executes the proposal includes its results. */
export async function actProposalWithOutcome(account, daoId, id, action) {
  const proposal = await getCoreProposal(daoId, id);
  return callWithOutcome(account, daoId, "act_proposal", { id: Number(id), action, proposal: proposal.kind });
}
