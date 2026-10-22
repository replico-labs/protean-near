import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseId, parseAccountId, choiceOf, tokenInfo, explain } from "../helpers.js";
import { loadProposal, describeProposal, followSwap } from "../proposals.js";
import { relayEvm } from "./evm.js";

const STAKE_VOTING = ["tokenWeighted", "quadratic", "liquid", "optimistic", "sowellian"];
const COUNCILS = ["delegate", "sortition"];

const idOption = [{ name: "id", description: "Proposal number", required: true, type: "integer" }];

/** The proposal after an action, with its buttons. */
async function show(ctx, dao, id, headline) {
  const token = await tokenInfo(dao);
  const p = await loadProposal(dao, id, token);
  return reply(`${headline}\n\n${describeProposal(p, token)}`, { buttons: p.buttons });
}

const VOTE_ERRORS = {
  ERR_ALREADY_VOTED: "You've already voted on this proposal.",
  ERR_PROPOSAL_NOT_ACTIVE: "Voting on this proposal isn't open.",
  ERR_NOT_COUNCIL_MEMBER: "Only council members vote in this DAO.",
  ERR_USE_SUPPORT: "Conviction DAOs don't vote: back a proposal with support instead.",
  ERR_PERMISSION_DENIED: "Only the board's members vote.",
  ERR_PROPOSAL_NOT_READY_FOR_VOTE: "Voting on this proposal is over.",
};

const vote = {
  section: "Deciding",
  usage: "<id> for|against|abstain",
  description: "Vote on a proposal",
  models: ["board", ...STAKE_VOTING, ...COUNCILS],
  options: [...idOption, { name: "choice", description: "for, against or abstain", required: true, choices: ["for", "against", "abstain"] }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("vote")} <id> for|against|abstain`;
    const id = parseId(ctx.args[0], usage);
    const choice = choiceOf(ctx.args[1], usage);
    const account = await userAccount(ctx);
    if (dao.model === "board") {
      if (choice === "Abstain") throw new UserError("Board members approve or reject.");
      const evmTxs = services.evm.txsIn((await services.core.getCoreProposal(dao.daoId, id))?.description);
      const act = evmTxs ? services.core.actProposalWithOutcome : services.core.actProposal;
      const outcome = await explain(() => act(account, dao.daoId, id, choice === "For" ? "VoteApprove" : "VoteReject"), VOTE_ERRORS);
      const p = await services.core.getCoreProposal(dao.daoId, id);
      const passed = p.status === "Approved";
      const swapped = passed ? await followSwap(ctx, dao, p.kind, account) : "";
      const relayed = passed && evmTxs ? await relayEvm(evmTxs, outcome) : "";
      const result = await show(ctx, dao, id, `🗳 Voted *${choice.toLowerCase()}* on #${id}.${passed ? " It passed and was executed." : ""}`);
      return { ...result, text: result.text + swapped + relayed };
    }
    const outcome = await explain(() => services.orbit.vote(account, dao.orbitId, id, choice), VOTE_ERRORS);
    if (!outcome.counted) {
      throw new UserError("Your vote wasn't counted: you had no stake when this proposal was made. Stake now to vote on the next ones.");
    }
    if (dao.model === "liquid") {
      // Delegators whose chain ends here can now have their votes counted with /resolve.
      return show(ctx, dao, id, `🗳 Voted *${choice.toLowerCase()}* on #${id}. Anyone who delegated to you can add their weight with \`${ctx.cmd("resolve")} ${id}\`.`);
    }
    return show(ctx, dao, id, `🗳 Voted *${choice.toLowerCase()}* on #${id}.`);
  },
};

const execute = {
  section: "Deciding",
  usage: "<id>",
  description: "Execute a passed proposal on the DAO",
  models: [...STAKE_VOTING, "conviction", ...COUNCILS, "decisionMarkets"],
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("execute")} <id>`);
    const account = await userAccount(ctx);
    const before = await services.orbit.getProposal(dao.orbitId, id);
    if (before?.state === "Executed") throw new UserError(`#${id} was already executed.`);
    // A proposal with EVM transactions: keep the outcome, where the signatures are.
    const evmTxs = services.evm.txsIn(before?.description);
    const outcome = await explain(() => (evmTxs ? services.orbit.executeWithOutcome(account, dao.orbitId, id) : services.orbit.execute(account, dao.orbitId, id)), {
      ERR_TIMELOCK: "Its timelock isn't over yet; see when with the proposal's status.",
      ERR_PROPOSAL_NOT_PASSED: "That proposal hasn't passed.",
      ERR_EXECUTION_EXPIRED: "Its execution window has passed.",
      ERR_ALREADY_SENDING: "It's already being executed. Check again in a minute.",
    });
    const p = await services.orbit.getProposal(dao.orbitId, id);
    if (p.state !== "Executed") return show(ctx, dao, id, `#${id} couldn't be executed on the DAO yet. Try again in a minute.`);
    const swapped = await followSwap(ctx, dao, p.kind, account);
    const relayed = evmTxs ? await relayEvm(evmTxs, outcome) : "";
    const result = await show(ctx, dao, id, `▶️ #${id} was executed on the DAO.`);
    return { ...result, text: result.text + swapped + relayed };
  },
};

const cancel = {
  section: "Deciding",
  usage: "<id>",
  description: "Withdraw your own proposal",
  models: [...STAKE_VOTING, "conviction", ...COUNCILS, "decisionMarkets"],
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("cancel")} <id>`);
    const account = await userAccount(ctx);
    await explain(() => services.orbit.cancel(account, dao.orbitId, id), { ERR_NOT_PROPOSER: "Only its proposer can cancel a proposal.", ERR_PROPOSAL_CLOSED: "That proposal is already closed." });
    return reply(`#${id} was cancelled.`);
  },
};

// --- Optimistic ---

const challenge = {
  section: "Deciding",
  usage: "<id>",
  description: "Challenge a proposal with a bond, sending it to a vote",
  models: ["optimistic"],
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("challenge")} <id>`);
    const { settings } = services.orbit.modelOf(await services.orbit.getModel(dao.orbitId));
    const token = await tokenInfo(dao);
    const account = await userAccount(ctx);
    const balance = await services.staking.tokenBalance(token.id, account.accountId);
    const bond = BigInt(settings.challenge_bond);
    if (balance < bond) throw new UserError(`Challenging takes a ${token.format(bond)} bond; you have ${token.format(balance)} unstaked.`);
    await services.orbit.challenge(account, token.id, dao.orbitId, id, bond);
    const p = await services.orbit.getProposal(dao.orbitId, id);
    if (p.challenger !== account.accountId) throw new UserError("The challenge didn't go through: its challenge window may have closed, or someone challenged first. Your bond was returned.");
    return show(ctx, dao, id, `⚔️ Challenged #${id} with a ${token.format(bond)} bond. It now goes to a vote.`);
  },
};

const resolvechallenge = {
  section: "Deciding",
  usage: "<id>",
  description: "After a challenged vote, settle the bond",
  models: ["optimistic"],
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("resolvechallenge")} <id>`);
    const account = await userAccount(ctx);
    const p = await services.orbit.getProposal(dao.orbitId, id);
    await explain(() => services.orbit.resolveChallenge(account, dao.orbitId, id), { ERR_NOT_CHALLENGED: "That proposal wasn't challenged.", ERR_BOND_RESOLVED: "Its bond was already settled.", ERR_VOTING_NOT_OVER: "Its vote isn't over yet." });
    const to = p.state === "Defeated" ? `back to the challenger \`${p.challenger}\`` : "to the treasury";
    return reply(`The bond on #${id} went ${to}.`);
  },
};

// --- Liquid ---

const delegate = {
  section: "Deciding",
  usage: "<account>",
  description: "Delegate your vote; you can still vote directly",
  models: ["liquid"],
  options: [{ name: "to", description: "NEAR account to follow", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const to = await parseAccountId(ctx, ctx.args[0], `${ctx.cmd("delegate")} <account>`);
    const account = await userAccount(ctx);
    await explain(() => services.orbit.delegate(account, dao.orbitId, to), { ERR_SELF_DELEGATION: "You can't delegate to yourself." });
    return reply(`✅ Your vote now follows \`${to}\`. When they vote, \`${ctx.cmd("resolve")} <id>\` adds your weight.`);
  },
};

const undelegate = {
  section: "Deciding",
  usage: "",
  description: "Stop delegating your vote",
  models: ["liquid"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const account = await userAccount(ctx);
    await explain(() => services.orbit.undelegate(account, dao.orbitId), { ERR_NOT_DELEGATED: "You aren't delegating." });
    return reply("✅ You no longer delegate your vote.");
  },
};

const resolve = {
  section: "Deciding",
  usage: "<id> [delegator]",
  description: "Count a delegated vote: yours by default",
  models: ["liquid"],
  options: [...idOption, { name: "delegator", description: "Whose delegation to count (default: you)", required: false }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("resolve")} <id> [delegator]`;
    const id = parseId(ctx.args[0], usage);
    const account = await userAccount(ctx);
    const delegator = ctx.args[1] ? await parseAccountId(ctx, ctx.args[1], usage) : account.accountId;
    const outcome = await explain(() => services.orbit.resolveDelegatedVote(account, dao.orbitId, id, delegator), {
      ERR_DELEGATE_HAS_NOT_VOTED: "Nobody in that delegation chain has voted yet.",
      ERR_NOT_DELEGATED: "That account doesn't delegate.",
      ERR_ALREADY_VOTED: "That vote is already counted.",
      ERR_PROPOSAL_NOT_ACTIVE: "Voting on this proposal isn't open.",
    });
    if (!outcome?.counted) throw new UserError(`\`${delegator}\` had no stake when this proposal was made.`);
    return show(ctx, dao, id, `🔗 Counted \`${delegator}\`'s delegated vote on #${id}.`);
  },
};

// --- Conviction ---

const support = {
  section: "Deciding",
  usage: "<id>",
  description: "Back a proposal with all your unlocked stake",
  models: ["conviction"],
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("support")} <id>`);
    const account = await userAccount(ctx);
    const token = await tokenInfo(dao);
    const locked = await explain(() => services.orbit.support(account, dao.orbitId, id), {
      ERR_ALREADY_SUPPORTING: "You already back this proposal.",
      ERR_PROPOSAL_NOT_ACTIVE: "That proposal isn't open.",
      ERR_SUPPORT_PENDING: "Your last support is still being recorded. Try again in a moment.",
    });
    if (!locked || BigInt(locked) === 0n) throw new UserError(`You have no unlocked stake to back it with. \`${ctx.cmd("stake")}\` first.`);
    return show(ctx, dao, id, `💪 You back #${id} with ${token.format(locked)}; it's locked until you \`${ctx.cmd("withdrawsupport")}\`.`);
  },
};

const withdrawsupport = {
  section: "Deciding",
  usage: "",
  description: "Stop backing a proposal and unlock your stake",
  models: ["conviction"],
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const account = await userAccount(ctx);
    await explain(() => services.orbit.withdrawSupport(account, dao.orbitId), { ERR_NOT_SUPPORTING: "You don't back any proposal." });
    return reply("✅ Support withdrawn; your stake is unlocked.");
  },
};

const queue = {
  section: "Deciding",
  usage: "<id>",
  description: "Queue a proposal whose conviction is high enough",
  models: ["conviction"],
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("queue")} <id>`);
    const account = await userAccount(ctx);
    await explain(() => services.orbit.queue(account, dao.orbitId, id), { ERR_NOT_ENOUGH_CONVICTION: "Its conviction isn't high enough yet.", ERR_PROPOSAL_NOT_ACTIVE: "That proposal isn't open." });
    return show(ctx, dao, id, `⏳ #${id} is queued.`);
  },
};

export const DECIDING_COMMANDS = { vote, execute, cancel, challenge, resolvechallenge, delegate, undelegate, resolve, support, withdrawsupport, queue };
