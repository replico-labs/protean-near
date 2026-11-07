import { describeKind, kindTokens } from "../near/kinds.js";
import { readable } from "../near/evm.js";
import { proposalButtons } from "../buttons.js";
import { proposalPageUrl } from "../proposalPages.js";
import { services } from "./services.js";
import { formatNear, formatTime, nowNs } from "./helpers.js";
import { isCoreBoard } from "../near/models.js";

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
  if (isCoreBoard(link)) {
    const p = await services.core.getCoreProposal(link.daoId, id).catch(() => null);
    if (!p) return null;
    const counts = p.vote_counts?.governance ?? ["0", "0", "0"];
    const lines = [`Status: *${p.status}*`, `Approve ${counts[0]} · Reject ${counts[1]}`];
    await services.tokens.load(kindTokens(p.kind));
    return { id, description: p.description, kind: p.kind, state: p.status, lines, buttons: proposalButtons("coreBoard", id, p.status, proposalPageUrl(link, id)) };
  }
  const p = await services.orbit.getProposal(link.orbitId, id);
  if (!p) return null;
  const fmt = token.format;
  await services.tokens.load(kindTokens(p.kind));
  const lines = [`Status: *${p.state}*${p.sending ? " (executing...)" : ""}`];
  if (link.model === "conviction") {
    lines.push(`Conviction ${fmt(p.conviction)} of ${fmt(p.required_conviction)} needed · backed by ${fmt(p.support)}`);
  } else if (link.model === "delegate" || link.model === "sortition" || link.model === "board") {
    lines.push(`${link.model === "board" ? "Member" : "Council"} votes: for ${p.for_votes} · against ${p.against_votes} · abstain ${p.abstain_votes}`);
  } else {
    const unit = link.model === "quadratic" ? (v) => `${v} (√ weight)` : fmt;
    lines.push(`For ${unit(p.for_votes)} · Against ${unit(p.against_votes)} · Abstain ${unit(p.abstain_votes)} · ${p.voters} voter${p.voters === 1 ? "" : "s"}`);
  }
  if (p.challenger) lines.push(`Challenged by \`${p.challenger}\``);
  const market = await marketOf(link, id);
  if (market.bet) lines.push(...betLines(market.bet, fmt));
  if (market.exchange) lines.push(...exchangeLines(market.exchange, fmt));
  if (p.state === "Pending" && BigInt(p.start) > nowNs()) lines.push(`Voting opens ${formatTime(p.start)}`);
  if (p.state === "Active" && link.model !== "conviction") lines.push(`Voting ends ${formatTime(p.end)}`);
  if (p.state === "ChallengeWindow") lines.push(`Passes unless challenged by ${formatTime(p.end)}`);
  if (p.executable_after && BigInt(p.executable_after) > nowNs()) lines.push(`Executable from ${formatTime(p.executable_after)}`);
  if (p.guard) {
    const i = await services.guard.getInstruction(p.guard, p.guard_instruction).catch(() => null);
    const config = i && (await services.guard.getConfig(p.guard).catch(() => null));
    if (i && config) {
      lines.push(i.state === "Pending" ? `🛡 Waiting for the guard: instruction #${i.id}, ${i.confirmations} of ${config.threshold} signers confirmed` : `🛡 Guard instruction #${i.id}: *${i.state}*`);
    }
  }
  if (p.core_proposal_id !== null && p.core_proposal_id !== undefined) {
    const coreProposal = await services.core.getCoreProposal(link.daoId, p.core_proposal_id).catch(() => null);
    lines.push(`On the DAO: proposal ${p.core_proposal_id}${coreProposal ? `, ${coreProposal.status}` : ""}`);
  }
  return { id, description: p.description, kind: p.kind, state: p.state, lines, buttons: proposalButtons(link.model, id, p.state, proposalPageUrl(link, id), market) };
}

/**
 * What a Sowellian or decision-markets proposal's buttons go by: { bet } or
 * { exchange }, with `now`. Other models: { now }.
 */
export async function marketOf(link, id) {
  if (link.model !== "sowellian" && link.model !== "decisionMarkets") return { now: nowNs() };
  // Their phases end at deadlines the contract checks against the chain's clock.
  const now = await services.clock.now().catch(() => nowNs());
  if (link.model === "sowellian") return { bet: await services.orbit.getBet(link.orbitId, id), now };
  if (link.model === "decisionMarkets") {
    const found = await services.orbit.getExchange(link.orbitId, id);
    return found ? { exchange: { ...found[0], twaps: [found[1], found[2]] }, now } : { now };
  }
  return { now };
}

/** Sowellian: the market and the resolution so far. */
function betLines(bet, fmt) {
  const lines = [`Market: YES ${fmt(bet.yes_pool)} · NO ${fmt(bet.no_pool)}`];
  if (bet.measurement_deadline) lines.push(`Measuring until ${formatTime(bet.measurement_deadline)}`);
  if (bet.resolver) lines.push(`Resolution proposed: *${bet.proposed_outcome}* by \`${bet.resolver}\``);
  if (bet.challenger) lines.push(`Disputed by \`${bet.challenger}\`; adjudication until ${formatTime(bet.adjudication_end)}`);
  if (bet.outcome) lines.push(`Outcome: *${bet.outcome}*`);
  return lines;
}

/** Decision markets: seeds, prices and the TWAPs. */
function exchangeLines(e, fmt) {
  const [passTwap, failTwap] = e.twaps;
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
  if (isCoreBoard(link)) {
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
 * Brings the chat's link in line with who governs the DAO now, after
 * something that can change it executed: a model switch, a token change,
 * a guard turned on or off, or (behind a guard) a confirmed instruction.
 * Reads the chain: the core's member is an orbit, or a guard whose
 * governance is the orbit. Returns a line for the reply, or "". `account`
 * (optional) claims the staking locker for a new conviction orbit.
 */
export async function syncGovernance(platform, chatId, account = null) {
  const link = services.db.getChatDao(platform, chatId);
  if (!link || isCoreBoard(link)) return link && !link.orbitId ? await syncCoreBoard(platform, chatId, link) : "";
  const governing = await services.core.governingMembers(link.daoId);
  if (governing.length !== 1) return "";
  const [member] = governing;
  let orbitId = member;
  let guardId = null;
  if (member !== link.orbitId) {
    const governance = await services.guard.getConfig(member).then((c) => c.governance).catch(() => null);
    if (governance) [orbitId, guardId] = [governance, member];
  } else if (link.guardId) {
    guardId = null;
  }
  if (orbitId === link.orbitId && (guardId ?? null) === (link.guardId ?? null)) return "";
  return adopt(platform, chatId, link, orbitId, guardId, account);
}

/** A core board that handed itself to an orbit (or guard). */
async function syncCoreBoard(platform, chatId, link) {
  const governing = await services.core.governingMembers(link.daoId);
  if (governing.length !== 1 || !(await services.orbit.getDao(governing[0]).catch(() => null))) return "";
  return adopt(platform, chatId, link, governing[0], null, null);
}

async function adopt(platform, chatId, link, orbitId, guardId, account) {
  const [model, tokenId, stakingId] = await Promise.all([
    services.orbit.getModel(orbitId).then((m) => services.orbit.modelOf(m).name),
    services.orbit.getToken(orbitId),
    services.orbit.getStakingContract(orbitId),
  ]);
  if (model === "conviction" && account) await services.orbit.claimLocker(account, orbitId).catch(() => {});
  const lines = [];
  const next = { ...link, orbitId, model, tokenId, stakingId, guardId: guardId ?? undefined, pendingSwap: undefined, pendingGuard: undefined };
  if (orbitId !== link.orbitId) lines.push(`🔀 The DAO now runs *${model}* governance (\`${orbitId}\`). Same treasury.`);
  if (tokenId !== link.tokenId) {
    const change = link.pendingTokenChange?.orbitId === orbitId ? link.pendingTokenChange : null;
    if (change) next.migration = { oldTokenId: link.tokenId, oldStakingId: link.stakingId, migratorId: change.migratorId };
    next.pendingTokenChange = undefined;
    const token = await services.staking.tokenMetadata(tokenId);
    lines.push(`🪙 The DAO's token is now *${token.symbol}* (\`${tokenId}\`).${change ? " Swap your old tokens with `/migrate all`; they're staked in the new vault for you." : ""}`);
  } else if (orbitId !== link.orbitId) {
    lines.push("Stakes carry over.");
  }
  if (guardId && guardId !== link.guardId) lines.push(`🛡 A guard (\`${guardId}\`) now confirms what passes before it runs.`);
  if (!guardId && link.guardId) lines.push("🛡 The guard is off: passed proposals run on the DAO directly.");
  services.db.setChatDao(platform, chatId, next);
  return lines.length ? `\n\n${lines.join(" ")}` : "";
}
