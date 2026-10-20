import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseId, parseAccountId, choiceOf, tokenInfo, formatTime, explain } from "../helpers.js";

/** The latest election's id, or a UserError. */
async function latestElection(ctx, dao) {
  const count = await services.orbit.getElectionCount(dao.orbitId);
  if (!count) throw new UserError(`There's no election yet. Once the term is over, \`${ctx.cmd("startelection")}\` opens one.`);
  return count - 1;
}

const list = (accounts) => (accounts.length ? accounts.map((a) => `\`${a}\``).join(", ") : "nobody");

const startelection = {
  section: "Council",
  usage: "",
  description: "Open an election once the council's term is over",
  models: ["delegate"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const account = await userAccount(ctx);
    const id = await explain(() => services.orbit.startElection(account, dao.orbitId), {
      ERR_TERM_NOT_OVER: "The council's term isn't over yet.",
      ERR_ELECTION_ACTIVE: "An election is already running.",
    });
    const [election] = await services.orbit.getElection(dao.orbitId, id);
    return reply(`🗳 Election #${id} is open. Stand with \`${ctx.cmd("declarecandidacy")}\` until ${formatTime(election.candidacy_end)}; voting runs until ${formatTime(election.voting_end)}.`);
  },
};

const declarecandidacy = {
  section: "Council",
  usage: "",
  description: "Stand for the council in the current election",
  models: ["delegate"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = await latestElection(ctx, dao);
    const account = await userAccount(ctx);
    const ok = await explain(() => services.orbit.declareCandidacy(account, dao.orbitId, id), {
      ERR_CANDIDACY_CLOSED: "Candidacy for this election has closed.",
      ERR_ALREADY_CANDIDATE: "You're already standing.",
    });
    if (!ok) {
      const { settings } = services.orbit.modelOf(await services.orbit.getModel(dao.orbitId));
      throw new UserError(`Standing needs ${(await tokenInfo(dao)).format(settings.candidacy_threshold)} staked.`);
    }
    return reply(`✅ \`${account.accountId}\` is standing in election #${id}.`);
  },
};

const voteinelection = {
  section: "Council",
  usage: "<candidates...>",
  description: "Vote for up to one candidate per seat with your stake",
  models: ["delegate"],
  options: [{ name: "candidates", description: "Candidate NEAR accounts", required: true, rest: true }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("voteinelection")} <candidates...>`;
    if (!ctx.args.length) throw new UserError(`Usage: \`${usage}\``);
    const candidates = [];
    for (const raw of ctx.args) candidates.push(await parseAccountId(ctx, raw, usage));
    const id = await latestElection(ctx, dao);
    const account = await userAccount(ctx);
    const weight = await explain(() => services.orbit.voteInElection(account, dao.orbitId, id, candidates), {
      ERR_ELECTION_NOT_VOTING: "Voting hasn't opened yet: candidacy is still running.",
      ERR_ELECTION_CLOSED: "Voting in this election has closed.",
      ERR_TOO_MANY_CANDIDATES: "Vote for at least one candidate and at most one per seat.",
      ERR_NOT_A_CANDIDATE: "One of those isn't standing.",
      ERR_DUPLICATE_CANDIDATE: "Name each candidate once.",
      ERR_ALREADY_VOTED: "You've already voted in this election.",
    });
    if (BigInt(weight ?? 0) === 0n) throw new UserError("Your vote wasn't counted: you had no stake when the election opened.");
    return reply(`🗳 Voted for ${list(candidates)} in election #${id} with ${(await tokenInfo(dao)).format(weight)}.`);
  },
};

const finalizeelection = {
  section: "Council",
  usage: "",
  description: "Seat the winners once the election's voting is over",
  models: ["delegate"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = await latestElection(ctx, dao);
    const account = await userAccount(ctx);
    const council = await explain(() => services.orbit.finalizeElection(account, dao.orbitId, id), {
      ERR_ELECTION_NOT_OVER: "Voting isn't over yet.",
      ERR_ELECTION_FINALIZED: "This election is already decided.",
    });
    return reply(`🏛 The new council: ${list(council)}.`);
  },
};

const recall = {
  section: "Council",
  usage: "<member>",
  description: "Start a vote to remove a council member",
  models: ["delegate"],
  options: [{ name: "member", description: "The council member's NEAR account", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const member = await parseAccountId(ctx, ctx.args[0], `${ctx.cmd("recall")} <member>`);
    const account = await userAccount(ctx);
    const id = await explain(() => services.orbit.initiateRecall(account, dao.orbitId, member), { ERR_NOT_COUNCIL_MEMBER: `\`${member}\` isn't on the council.` });
    if (id === null || id === undefined) {
      const { settings } = services.orbit.modelOf(await services.orbit.getModel(dao.orbitId));
      throw new UserError(`Starting a recall needs ${(await tokenInfo(dao)).format(settings.candidacy_threshold)} staked.`);
    }
    const r = await services.orbit.getRecall(dao.orbitId, id);
    return reply(`⚖️ Recall #${id} of \`${member}\` is open until ${formatTime(r.end)}. Vote with \`${ctx.cmd("voterecall")} ${id} for|against\`.`);
  },
};

const voterecall = {
  section: "Council",
  usage: "<id> for|against|abstain",
  description: "Vote on a recall with your stake",
  models: ["delegate"],
  options: [
    { name: "id", description: "Recall number", required: true, type: "integer" },
    { name: "choice", description: "for removes the member", required: true, choices: ["for", "against", "abstain"] },
  ],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("voterecall")} <id> for|against|abstain`;
    const id = parseId(ctx.args[0], usage);
    const choice = choiceOf(ctx.args[1], usage);
    const account = await userAccount(ctx);
    const weight = await explain(() => services.orbit.voteRecall(account, dao.orbitId, id, choice), {
      ERR_RECALL_CLOSED: "That recall is closed.",
      ERR_ALREADY_VOTED: "You've already voted on this recall.",
      ERR_NO_RECALL: "There's no such recall.",
    });
    if (BigInt(weight ?? 0) === 0n) throw new UserError("Your vote wasn't counted: you had no stake when the recall started.");
    return reply(`🗳 Voted *${choice.toLowerCase()}* on recall #${id}.`);
  },
};

const finalizerecall = {
  section: "Council",
  usage: "<id>",
  description: "Close a recall; removes the member if it passed",
  models: ["delegate"],
  options: [{ name: "id", description: "Recall number", required: true, type: "integer" }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("finalizerecall")} <id>`);
    const account = await userAccount(ctx);
    const removed = await explain(() => services.orbit.finalizeRecall(account, dao.orbitId, id), {
      ERR_RECALL_NOT_OVER: "The recall vote isn't over yet.",
      ERR_RECALL_FINALIZED: "That recall is already closed.",
    });
    const r = await services.orbit.getRecall(dao.orbitId, id);
    return reply(removed ? `\`${r.member}\` was removed from the council; the seat stays empty until the next election.` : `The recall of \`${r.member}\` failed.`);
  },
};

const registereligible = {
  section: "Council",
  usage: "",
  description: "Enter the pool the council is drawn from",
  models: ["sortition"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const account = await userAccount(ctx);
    const ok = await explain(() => services.orbit.registerEligible(account, dao.orbitId), { ERR_ALREADY_ELIGIBLE: "You're already in the pool." });
    if (!ok) {
      const { settings } = services.orbit.modelOf(await services.orbit.getModel(dao.orbitId));
      throw new UserError(`Joining the pool needs ${(await tokenInfo(dao)).format(settings.eligibility_threshold)} staked.`);
    }
    return reply(`✅ You're in the pool for the next draw.`);
  },
};

const withdraweligibility = {
  section: "Council",
  usage: "",
  description: "Leave the pool",
  models: ["sortition"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const account = await userAccount(ctx);
    await explain(() => services.orbit.withdrawEligibility(account, dao.orbitId), { ERR_NOT_ELIGIBLE: "You aren't in the pool." });
    return reply("✅ You've left the pool.");
  },
};

const draw = {
  section: "Council",
  usage: "",
  description: "Draw a new council at random once the term is over",
  models: ["sortition"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const account = await userAccount(ctx);
    const council = await explain(() => services.orbit.draw(account, dao.orbitId), { ERR_TERM_NOT_OVER: "The council's term isn't over yet.", ERR_EMPTY_POOL: "Nobody is in the pool yet." });
    return reply(`🎲 The new council: ${list(council)}.`);
  },
};

export const COUNCIL_COMMANDS = { startelection, declarecandidacy, voteinelection, finalizeelection, recall, voterecall, finalizerecall, registereligible, withdraweligibility, draw };
