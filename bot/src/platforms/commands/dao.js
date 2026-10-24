import { fromUnits } from "../../near/amounts.js";
import { MODELS } from "../../near/models.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, parseId, formatNear, tokenInfo, formatDuration, formatTime, nowNs, copyableAccount } from "../helpers.js";
import { loadProposal, describeProposal, latestProposals } from "../proposals.js";
import { pendingEditLink } from "../../proposalPages.js";

const bps = (b) => `${b / 100}%`;

/** The lines describing a model's rules, from the orbit's settings. */
function rulesLines(model, s, token) {
  const vote = (r) => [
    `To pass: ${bps(r.quorum_bps)} of staked weight voting, and ${bps(r.approval_bps)} of for + against in favour`,
    `Voting: ${formatDuration(r.voting_period)}${BigInt(r.voting_delay) > 0n ? ` after a ${formatDuration(r.voting_delay)} delay` : ""}; executable ${formatDuration(r.timelock)} after it ends`,
    ...(BigInt(r.proposal_threshold) > 0n ? [`Proposing needs ${token.format(r.proposal_threshold)} staked`] : []),
  ];
  const council = (c, size) => [`Council: ${size} seats; a proposal needs ${c.quorum} council votes and ${bps(c.approval_bps)} in favour`, `Voting: ${formatDuration(c.voting_period)}`];
  switch (model) {
    case "tokenWeighted":
    case "liquid":
      return vote(s);
    case "quadratic":
      return [...vote(s), "Each vote weighs the square root of the voter's stake"];
    case "optimistic":
      return [`Passes ${formatDuration(s.challenge_period)} after proposing unless challenged`, `Challenging takes a ${token.format(s.challenge_bond)} bond, then:`, ...vote(s.rules)];
    case "conviction":
      return [
        `Every proposal needs ${token.format(s.min_conviction)} of conviction; payouts and other actions need more (other actions: ${token.format(s.governance_conviction)})`,
        `Conviction grows ${token.format(s.growth_per_second)} per second toward a proposal's support`,
      ];
    case "delegate":
      return [...council(s.council, s.council_size), `Term: ${formatDuration(s.term_length)}; standing for election needs ${token.format(s.candidacy_threshold)} staked`];
    case "sortition":
      return [...council(s.council, s.council_size), `Term: ${formatDuration(s.term_length)}; joining the pool needs ${token.format(s.eligibility_threshold)} staked`];
    default:
      return [];
  }
}

const daoInfo = {
  section: "The DAO",
  needsDao: true,
  usage: "",
  description: "The DAO, its governance model and rules",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const [governing, staked] = await Promise.all([services.core.governingMembers(dao.daoId), services.staking.totalStaked(dao.stakingId)]);
    const lines = [`*DAO:* \`${dao.daoId}\` (Sputnik)`, `*Model:* ${MODELS[dao.model]}`, `*Token:* ${token.symbol} (\`${token.id}\`) · staked: ${token.format(staked)}`];
    if (dao.model === "board") {
      lines.push(`*Members:* ${governing.map((g) => `\`${g}\``).join(", ")}`, "Proposals pass with a majority of members.");
    } else {
      const { settings } = services.orbit.modelOf(await services.orbit.getModel(dao.orbitId));
      lines.push(`*Orbit:* \`${dao.orbitId}\``, "", ...rulesLines(dao.model, settings, token));
      if (!governing.includes(dao.orbitId)) lines.push("", `⚠️ The DAO is now governed by ${governing.map((g) => `\`${g}\``).join(", ")}. An admin should \`${ctx.cmd("link")}\` it again.`);
    }
    if (dao.pendingSwap) lines.push("", `🔀 Proposal #${dao.pendingSwap.proposalId} would switch to *${dao.pendingSwap.model}*.`);
    return reply(lines.join("\n"));
  },
};

/**
 * What else the treasury holds: wrapped NEAR and known tokens (from swaps),
 * and liquid staking positions. Only what it actually has; a venue that
 * can't be read is skipped.
 */
async function otherHoldings(daoId) {
  const tokenIds = [services.venues.wrapNear, ...Object.values(services.venues.tokens ?? {})].filter(Boolean);
  await services.tokens.load(tokenIds);
  const balances = await Promise.all(tokenIds.map((id) => services.staking.tokenBalance(id, daoId).catch(() => 0n)));
  const lines = tokenIds.flatMap((id, i) => (balances[i] > 0n ? [services.tokens.format(id, balances[i])] : []));
  // Held inside NEAR Intents (bought assets, refunds); mainnet only, and skipped if it can't be read.
  const intents = await services.intents
    .holdings(daoId)
    .then(async (held) => {
      const listed = held.length ? await services.intents.tokens() : [];
      return held.map(([assetId, amount]) => {
        const asset = listed.find((t) => t.assetId === assetId);
        return asset ? `${fromUnits(amount, asset.decimals)} ${asset.symbol}${asset.blockchain === "near" ? "" : ` (${asset.blockchain})`}` : `${amount} of ${assetId}`;
      });
    })
    .catch(() => []);
  if (intents.length) lines.push(`In NEAR Intents: ${intents.join(", ")}`);
  for (const [key] of services.lst.providers()) {
    const lst = services.lst.provider(key);
    const p = await services.lst.position(lst.id, daoId).catch(() => null);
    if (p && p.staked > 0n) lines.push(`Staked with ${lst.label}: ${formatNear(p.staked)} NEAR`);
    if (p && p.unstaked > 0n) lines.push(`Unstaking from ${lst.label}: ${formatNear(p.unstaked)} NEAR${p.available ? " (ready to withdraw)" : ""}`);
  }
  return lines;
}

const treasury = {
  section: "The DAO",
  needsDao: true,
  usage: "",
  description: "What the DAO holds",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const [near, tokens, holdings] = await Promise.all([
      services.core.treasuryNear(dao.daoId),
      services.staking.tokenBalance(token.id, dao.daoId),
      otherHoldings(dao.daoId),
    ]);
    return reply([`*Treasury of* ${copyableAccount(dao.daoId)}`, `NEAR: ${formatNear(near)}`, `${token.symbol}: ${token.format(tokens)}`, ...holdings].join("\n"));
  },
};

const proposals = {
  section: "The DAO",
  needsDao: true,
  usage: "",
  description: "The latest proposals",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const { count, items } = await latestProposals(dao);
    if (!count) return reply(`No proposals yet. Make one with \`${ctx.cmd("pay")}\` or \`${ctx.cmd("signal")}\`.`);
    const lines = items.map(([id, state, description]) => `#${id} *${state}* — ${services.evm.readable(description)}`);
    return reply([`*Proposals* (latest ${items.length} of ${count})`, ...lines, "", `Details: \`${ctx.cmd("proposal")} <id>\``].join("\n"));
  },
};

const proposal = {
  section: "The DAO",
  needsDao: true,
  usage: "<id>",
  description: "One proposal: action, votes and status",
  options: [{ name: "id", description: "Proposal number", required: true, type: "integer" }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const id = parseId(ctx.args[0], `${ctx.cmd("proposal")} <id>`);
    const token = await tokenInfo(dao);
    const p = await loadProposal(dao, id, token);
    if (!p) throw new UserError(`There's no proposal #${id}.`);
    // Its proposer, while the details are open, gets their edit link again.
    return reply(describeProposal(p, token), { buttons: p.buttons, private: await pendingEditLink(ctx, dao, id) });
  },
};

const council = {
  section: "The DAO",
  usage: "",
  description: "The council or board, its term, and any election",
  models: ["board", "delegate", "sortition"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    if (dao.model === "board") {
      const members = await services.core.governingMembers(dao.daoId);
      return reply(`*Board members:* ${members.map((m) => `\`${m}\``).join(", ")}`);
    }
    const [members, termEnd] = await Promise.all([services.orbit.getCouncil(dao.orbitId), services.orbit.getTermEnd(dao.orbitId)]);
    const lines = [`*Council:* ${members.length ? members.map((m) => `\`${m}\``).join(", ") : "empty"}`];
    const over = BigInt(termEnd) <= nowNs();
    lines.push(over ? `The term is over: ${dao.model === "delegate" ? `\`${ctx.cmd("startelection")}\`` : `\`${ctx.cmd("draw")}\``} picks the next council.` : `Term ends ${formatTime(termEnd)}`);
    if (dao.model === "delegate") {
      const count = await services.orbit.getElectionCount(dao.orbitId);
      if (count > 0) {
        const [election, votes] = await services.orbit.getElection(dao.orbitId, count - 1);
        if (!election.finalized) {
          lines.push("", `*Election #${count - 1}*: candidacy until ${formatTime(election.candidacy_end)}, voting until ${formatTime(election.voting_end)}`);
          for (const [candidate, weight] of votes) lines.push(`• \`${candidate}\` — ${(await tokenInfo(dao)).format(weight)}`);
        }
      }
    }
    if (dao.model === "sortition") lines.push(`Pool: ${(await services.orbit.getPool(dao.orbitId)).length} eligible members`);
    return reply(lines.join("\n"));
  },
};

export const DAO_COMMANDS = { dao: daoInfo, treasury, proposals, proposal, council };
