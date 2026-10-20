import { nearToYocto } from "near-api-js";
import { view, call } from "./client.js";

/**
 * An orbit (orbits/orbit): one contract for every model. Views take the
 * orbit's account; writes take the signing account first.
 */

/** Covers a proposal's storage on the orbit; it refunds what's left. */
const PROPOSAL_DEPOSIT = nearToYocto("0.01");
const ONE_YOCTO = 1n;

// --- Views ---

export const getDao = (orbitId) => view(orbitId, "get_dao");
export const getModel = (orbitId) => view(orbitId, "get_model");
export const getStakingContract = (orbitId) => view(orbitId, "get_staking_contract");
export const getToken = (orbitId) => view(orbitId, "get_token");
export const getProposalCount = (orbitId) => view(orbitId, "get_proposal_count");
export const getProposal = (orbitId, id) => view(orbitId, "get_proposal", { id: Number(id) });
export const getProposals = (orbitId, fromIndex, limit) => view(orbitId, "get_proposals", { from_index: fromIndex, limit });
export const getReceipt = (orbitId, id, accountId) => view(orbitId, "get_receipt", { id: Number(id), account_id: accountId });
export const getDelegate = (orbitId, accountId) => view(orbitId, "get_delegate", { account_id: accountId });
export const getChainTip = (orbitId, accountId) => view(orbitId, "get_chain_tip", { account_id: accountId });
export const getSupport = (orbitId, accountId) => view(orbitId, "get_support", { account_id: accountId });
export const getCouncil = (orbitId) => view(orbitId, "get_council");
export const getTermEnd = (orbitId) => view(orbitId, "get_term_end");
export const getElectionCount = (orbitId) => view(orbitId, "get_election_count");
export const getElection = (orbitId, id) => view(orbitId, "get_election", { id: Number(id) });
export const getRecallCount = (orbitId) => view(orbitId, "get_recall_count");
export const getRecall = (orbitId, id) => view(orbitId, "get_recall", { id: Number(id) });
export const getPool = (orbitId) => view(orbitId, "get_pool");

/** The model's name ("tokenWeighted", ...) and its settings, from get_model. */
export function modelOf(model) {
  const [name, settings] = Object.entries(model)[0];
  return { name: name[0].toLowerCase() + name.slice(1), settings };
}

// --- Proposals and votes ---

/** Proposes `kind` (a Sputnik proposal kind object). Returns the new proposal id. */
export function propose(account, orbitId, description, kind) {
  return call(account, orbitId, "propose", { description, kind: JSON.stringify(kind) }, { deposit: PROPOSAL_DEPOSIT });
}

/** "For", "Against" or "Abstain". Returns { counted, weight, state }. */
export function vote(account, orbitId, id, choice) {
  return call(account, orbitId, "vote", { id: Number(id), choice });
}

export const execute = (account, orbitId, id) => call(account, orbitId, "execute", { id: Number(id) });
export const cancel = (account, orbitId, id) => call(account, orbitId, "cancel", { id: Number(id) });

// --- Liquid ---

export const delegate = (account, orbitId, to) => call(account, orbitId, "delegate", { to });
export const undelegate = (account, orbitId) => call(account, orbitId, "undelegate");
export const resolveDelegatedVote = (account, orbitId, id, delegator) =>
  call(account, orbitId, "resolve_delegated_vote", { id: Number(id), delegator });

// --- Optimistic ---

/** Posts the challenge bond, in the DAO's token, on proposal `id`. */
export function challenge(account, tokenId, orbitId, id, bond) {
  return call(account, tokenId, "ft_transfer_call", { receiver_id: orbitId, amount: String(bond), msg: JSON.stringify({ challenge: Number(id) }) }, { deposit: ONE_YOCTO });
}

export const resolveChallenge = (account, orbitId, id) => call(account, orbitId, "resolve_challenge", { id: Number(id) });

// --- Conviction ---

export const support = (account, orbitId, id) => call(account, orbitId, "support", { id: Number(id) });
export const withdrawSupport = (account, orbitId) => call(account, orbitId, "withdraw_support");
export const queue = (account, orbitId, id) => call(account, orbitId, "queue", { id: Number(id) });
export const claimLocker = (account, orbitId) => call(account, orbitId, "claim_locker");

// --- Councils ---

export const startElection = (account, orbitId) => call(account, orbitId, "start_election");
export const declareCandidacy = (account, orbitId, id) => call(account, orbitId, "declare_candidacy", { id: Number(id) });
export const voteInElection = (account, orbitId, id, candidates) => call(account, orbitId, "vote_in_election", { id: Number(id), candidates });
export const finalizeElection = (account, orbitId, id) => call(account, orbitId, "finalize_election", { id: Number(id) });
export const initiateRecall = (account, orbitId, member) => call(account, orbitId, "initiate_recall", { member });
export const voteRecall = (account, orbitId, id, choice) => call(account, orbitId, "vote_recall", { id: Number(id), choice });
export const finalizeRecall = (account, orbitId, id) => call(account, orbitId, "finalize_recall", { id: Number(id) });
export const registerEligible = (account, orbitId) => call(account, orbitId, "register_eligible");
export const withdrawEligibility = (account, orbitId) => call(account, orbitId, "withdraw_eligibility");
export const draw = (account, orbitId) => call(account, orbitId, "draw");

// --- Sowellian ---

export const getBet = (orbitId, id) => view(orbitId, "get_bet", { id: Number(id) });
export const getPosition = (orbitId, id, accountId) => view(orbitId, "get_position", { id: Number(id), account_id: accountId });

/** Proposes with success criteria (human-resolved by default). Returns the id. */
export function proposeWithCriteria(account, orbitId, description, kind, measurementPeriod, criteria = "Human") {
  return call(account, orbitId, "propose_with_criteria", { description, kind: JSON.stringify(kind), criteria, measurement_period: measurementPeriod }, { deposit: PROPOSAL_DEPOSIT });
}

/** Sends `amount` of the DAO's token to the orbit with `msg` (a bond, a position, a seed...). */
export function sendToOrbit(account, tokenId, orbitId, amount, msg) {
  return call(account, tokenId, "ft_transfer_call", { receiver_id: orbitId, amount: String(amount), msg: JSON.stringify(msg) }, { deposit: ONE_YOCTO });
}

export const adjudicate = (account, orbitId, id, outcome) => call(account, orbitId, "adjudicate", { id: Number(id), outcome });
export const finalizeResolution = (account, orbitId, id) => call(account, orbitId, "finalize_resolution", { id: Number(id) });
export const finalizeAdjudication = (account, orbitId, id) => call(account, orbitId, "finalize_adjudication", { id: Number(id) });
export const resolveViaOracle = (account, orbitId, id) => call(account, orbitId, "resolve_via_oracle", { id: Number(id) });
export const forfeitBond = (account, orbitId, id) => call(account, orbitId, "forfeit_bond", { id: Number(id) });
export const claimPosition = (account, orbitId, id) => call(account, orbitId, "claim_position", { id: Number(id) });

// --- Decision markets ---

export const getExchange = (orbitId, id) => view(orbitId, "get_exchange", { id: Number(id) });
export const getHoldings = (orbitId, id, accountId) => view(orbitId, "get_holdings", { id: Number(id), account_id: accountId });
export const seedNear = (account, orbitId, id, amount) => call(account, orbitId, "seed_near", { id: Number(id) }, { deposit: BigInt(amount) });
export const splitNear = (account, orbitId, id, amount) => call(account, orbitId, "split_near", { id: Number(id) }, { deposit: BigInt(amount) });
export const merge = (account, orbitId, id, asset, amount) => call(account, orbitId, "merge", { id: Number(id), asset, amount: String(amount) });
/** Sells `amount` of `asset` units in the `side` market. Returns what it bought. */
export const trade = (account, orbitId, id, side, asset, amount, minOut = 1n) =>
  call(account, orbitId, "trade", { id: Number(id), side, asset_in: asset, amount_in: String(amount), min_out: String(minOut) });
export const redeem = (account, orbitId, id) => call(account, orbitId, "redeem", { id: Number(id) });
export const reclaimLiquidity = (account, orbitId, id) => call(account, orbitId, "reclaim_liquidity", { id: Number(id) });
