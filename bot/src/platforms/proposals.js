import { describeKind, kindTokens } from "../near/kinds.js";
import { readable } from "../near/evm.js";
import { proposalButtons } from "../buttons.js";
import { services } from "./services.js";
import { formatNear, formatTime, nowNs } from "./helpers.js";

/**
 * Reading and describing a chat's proposals: orbit proposals, or for a
 * board, the core's own proposals.
 */

/** A swap proposal's new orbit, or null. */
export function swapTarget(kind) {
  const role = kind?.ChangePolicyAddOrUpdateRole?.role;
  return role?.name === "governance" ? (role.kind?.Group?.[0] ?? null) : null;
}

/** One proposal, normalized: { id, description, kind, state, lines, buttons } or null. */
export async function loadProposal(link, id, token) {
  if (link.model === "board") {
    const p = await services.core.getCoreProposal(link.daoId, id).catch(() => null);
    if (!p) return null;
    const counts = p.vote_counts?.governance ?? ["0", "0", "0"];
    const lines = [`Status: *${p.status}*`, `Approve ${counts[0]} · Reject ${counts[1]}`];
    await services.tokens.load(kindTokens(p.kind));
    return { id, description: p.description, kind: p.kind, state: p.status, lines, buttons: proposalButtons("board", id, p.status) };
  }
  const p = await services.orbit.getProposal(link.orbitId, id);
  if (!p) return null;
  const fmt = token.format;
  await services.tokens.load(kindTokens(p.kind));
  const lines = [`Status: *${p.state}*${p.sending ? " (executing...)" : ""}`];
  if (link.model === "conviction") {
    lines.push(`Conviction ${fmt(p.conviction)} of ${fmt(p.required_conviction)} needed · backed by ${fmt(p.support)}`);
  } else if (link.model === "delegate" || link.model === "sortition") {
    lines.push(`Council votes: for ${p.for_votes} · against ${p.against_votes} · abstain ${p.abstain_votes}`);
  } else {
    const unit = link.model === "quadratic" ? (v) => `${v} (√ weight)` : fmt;
    lines.push(`For ${unit(p.for_votes)} · Against ${unit(p.against_votes)} · Abstain ${unit(p.abstain_votes)} · ${p.voters} voter${p.voters === 1 ? "" : "s"}`);
  }
  if (p.challenger) lines.push(`Challenged by \`${p.challenger}\``);
  if (link.model === "sowellian") lines.push(...(await betLines(link, id, fmt)));
  if (link.model === "decisionMarkets") lines.push(...(await exchangeLines(link, id, fmt)));
  if (p.state === "Pending" && BigInt(p.start) > nowNs()) lines.push(`Voting opens ${formatTime(p.start)}`);
  if (p.state === "Active" && link.model !== "conviction") lines.push(`Voting ends ${formatTime(p.end)}`);
  if (p.state === "ChallengeWindow") lines.push(`Passes unless challenged by ${formatTime(p.end)}`);
  if (p.executable_after && BigInt(p.executable_after) > nowNs()) lines.push(`Executable from ${formatTime(p.executable_after)}`);
  if (p.core_proposal_id !== null && p.core_proposal_id !== undefined) {
    const coreProposal = await services.core.getCoreProposal(link.daoId, p.core_proposal_id).catch(() => null);
    lines.push(`On the DAO: proposal ${p.core_proposal_id}${coreProposal ? `, ${coreProposal.status}` : ""}`);
  }
  return { id, description: p.description, kind: p.kind, state: p.state, lines, buttons: proposalButtons(link.model, id, p.state) };
}

/** Sowellian: the market and the resolution so far. */
async function betLines(link, id, fmt) {
  const bet = await services.orbit.getBet(link.orbitId, id);
  if (!bet) return [];
  const lines = [`Market: YES ${fmt(bet.yes_pool)} · NO ${fmt(bet.no_pool)}`];
  if (bet.measurement_deadline) lines.push(`Measuring until ${formatTime(bet.measurement_deadline)}`);
  if (bet.resolver) lines.push(`Resolution proposed: *${bet.proposed_outcome}* by \`${bet.resolver}\``);
  if (bet.challenger) lines.push(`Disputed by \`${bet.challenger}\`; adjudication until ${formatTime(bet.adjudication_end)}`);
  if (bet.outcome) lines.push(`Outcome: *${bet.outcome}*`);
  return lines;
}

/** Decision markets: seeds, prices and the TWAPs. */
async function exchangeLines(link, id, fmt) {
  const found = await services.orbit.getExchange(link.orbitId, id);
  if (!found) return [];
  const [e, passTwap, failTwap] = found;
  if (!e.opened_at) return [`Waiting for seeds: ${BigInt(e.token_seed) > 0n ? "token ✅" : "token ⏳"} ${BigInt(e.near_seed) > 0n ? "NEAR ✅" : "NEAR ⏳"}`];
  const price = (pool) => (BigInt(pool.token) > 0n ? formatNear((BigInt(pool.near) * 10n ** 18n) / BigInt(pool.token)) : "0");
  return [
    `Pass market: ${price(e.pass)} NEAR per token · Fail market: ${price(e.fail)} NEAR per token`,
    `Average so far: pass ${formatNear(passTwap)} · fail ${formatNear(failTwap)} (per token, ×10¹⁸ raw)`,
    `Trading until ${formatTime(e.deadline)}`,
  ];
}

/** A proposal's summary paragraph. */
export function describeProposal(p, token) {
  const action = describeKind(p.kind, {
    formatNear,
    formatToken: (id, amount) => (id === token.id ? token.format(amount) : services.tokens.format(id, amount)),
  });
  return [`*#${p.id}* — ${readable(p.description)}`, `Action: ${action}`, ...p.lines].join("\n");
}

/** The latest `limit` proposals, newest first, as [id, state, description]. */
export async function latestProposals(link, limit = 10) {
  if (link.model === "board") {
    const last = await services.core.getLastProposalId(link.daoId);
    const from = Math.max(0, last - limit);
    const list = await services.core.getCoreProposals(link.daoId, from, limit);
    return { count: last, items: list.reverse().map((p) => [p.id, p.status, p.description]) };
  }
  const count = await services.orbit.getProposalCount(link.orbitId);
  const list = count ? await services.orbit.getProposals(link.orbitId, Math.max(0, count - limit), limit) : [];
  return { count, items: list.reverse().map((p) => [p.id, p.state, p.description]) };
}

/**
 * After a proposal executed: if it was a swap, the chat now follows the new
 * orbit and its model; a conviction orbit also becomes the staking locker.
 * Returns a line for the reply, or "".
 */
export async function followSwap(ctx, link, kind, account) {
  const newOrbit = swapTarget(kind);
  if (!newOrbit) return "";
  const governing = await services.core.governingMembers(link.daoId);
  if (!governing.includes(newOrbit)) return "";
  const { name: model } = services.orbit.modelOf(await services.orbit.getModel(newOrbit));
  if (model === "conviction") await services.orbit.claimLocker(account, newOrbit);
  services.db.setChatDao(ctx.platform, ctx.chatId, { ...link, orbitId: newOrbit, model, pendingSwap: undefined });
  return `\n\n🔀 The DAO now runs *${model}* governance (\`${newOrbit}\`). Same treasury, same stakes.`;
}
