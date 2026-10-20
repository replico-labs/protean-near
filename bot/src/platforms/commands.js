import { helpReply } from "../helpMenu.js";
import { proposalButtons } from "../buttons.js";
import { NEAR_DECIMALS, fromUnits } from "../near/amounts.js";
import { ChainError } from "../near/client.js";
import * as kinds from "../near/kinds.js";
import { services } from "./services.js";
import {
  UserError,
  reply,
  requireDao,
  userAccount,
  parseId,
  parseAmount,
  parseAccountId,
  formatNear,
  tokenInfo,
  formatDuration,
  formatTime,
} from "./helpers.js";

/**
 * Platform-neutral commands for the Telegram and Discord front-ends.
 *
 * Each command takes a context and returns a reply. Context:
 *   platform  "telegram" | "discord" - the chat-link and wallet key prefix
 *   chatId    the group or channel; one chat links to one DAO
 *   userId    platform user ID; one NEAR account per (platform, userId)
 *   args      positional words, in each command's `options` order
 *   isAdmin   true/false if the platform can tell, undefined if it can't
 *   isDirect  true in a one-to-one chat
 *   cmd(name) how this platform spells a command, for usage hints
 *
 * Replies use Telegram-style markdown (*bold*, `code`). A reply is
 * { text, ephemeral?, buttons? }. `options` drives Discord slash-command
 * registration; `section` and `usage` drive help.
 */

/** The chat's orbit: every vote and proposal goes through it. */
const orbitOf = (link) => link.orbitId;

const help = {
  section: "Help",
  usage: "[topic]",
  description: "The commands, by topic",
  ephemeralByDefault: true,
  options: [{ name: "topic", description: "One topic, or all", required: false, choices: ["setup", "wallet", "dao", "proposing", "deciding", "all"] }],
  async run(ctx) {
    const link = services.db.getChatDao(ctx.platform, ctx.chatId);
    const sections = Object.entries(SECTIONS).map(([title, key]) => ({
      key,
      title,
      lines: Object.entries(COMMANDS)
        .filter(([, c]) => c.section === title)
        .map(([name, c]) => `\`${ctx.cmd(name)}${c.usage ? " " + c.usage : ""}\` — ${c.description}`),
    }));
    const intro = link
      ? `*Protean on NEAR* — this chat runs \`${link.daoId}\` with token-weight governance`
      : "*Protean on NEAR* — no DAO linked here yet";
    const { text, buttons } = helpReply({ sections, topic: ctx.args?.[0], intro, cmd: ctx.cmd });
    return reply(text, { ephemeral: true, buttons });
  },
};

const SECTIONS = { Setup: "setup", "Your wallet": "wallet", "The DAO": "dao", Proposing: "proposing", Deciding: "deciding" };

// --- Setup ---

const link = {
  section: "Setup",
  usage: "<dao> <orbit>",
  description: "Link this chat to a DAO and the orbit governing it (admins)",
  options: [
    { name: "dao", description: "The Sputnik DAO, e.g. mydao.sputnikv2.testnet", required: true },
    { name: "orbit", description: "Its orbit, e.g. tw.mydao.orbits.testnet", required: true },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("link")} <dao> <orbit>`;
    const daoId = parseAccountId(ctx.args[0], usage);
    const orbitId = parseAccountId(ctx.args[1], usage);
    const { tokenWeight, core } = services;
    let boundTo;
    try {
      boundTo = await tokenWeight.getDao(orbitId);
    } catch {
      throw new UserError(`\`${orbitId}\` isn't a token-weight orbit.`);
    }
    if (boundTo !== daoId) throw new UserError(`\`${orbitId}\` governs \`${boundTo}\`, not \`${daoId}\`.`);
    const governing = await core.governingOrbits(daoId);
    if (!governing.includes(orbitId)) {
      throw new UserError(`\`${daoId}\` isn't governed by \`${orbitId}\` (its governance role holds: ${governing.join(", ") || "nobody"}).`);
    }
    const [stakingId, tokenId] = await Promise.all([tokenWeight.getStakingContract(orbitId), tokenWeight.getToken(orbitId)]);
    services.db.setChatDao(ctx.platform, ctx.chatId, { daoId, orbitId, orbitType: "tokenWeight", tokenId, stakingId, linkedBy: String(ctx.userId) });
    return reply(`✅ Linked to \`${daoId}\`, governed by \`${orbitId}\`.\nVoting token: \`${tokenId}\`. Members stake it with \`${ctx.cmd("stake")} <amount>\` to vote.`);
  },
};

const unlink = {
  section: "Setup",
  usage: "",
  description: "Unlink this chat's DAO (admins). The DAO itself is unchanged",
  options: [],
  async run(ctx) {
    requireDao(ctx);
    services.db.removeChatDao(ctx.platform, ctx.chatId);
    return reply("This chat is no longer linked to a DAO.");
  },
};

// --- Your wallet ---

const wallet = {
  section: "Your wallet",
  usage: "",
  description: "Your NEAR account, balances and voting weight",
  ephemeralByDefault: true,
  options: [],
  async run(ctx) {
    const account = await userAccount(ctx);
    const near = await services.wallets.availableBalance(account.accountId);
    const lines = [`*Your account:* \`${account.accountId}\``, `NEAR: ${formatNear(near)}`];
    const dao = services.db.getChatDao(ctx.platform, ctx.chatId);
    if (dao) {
      const token = await tokenInfo(dao);
      const fmt = (u) => `${fromUnits(u, token.decimals)} ${token.symbol}`;
      const [balance, weight, user] = await Promise.all([
        services.tokenWeight.tokenBalance(token.id, account.accountId),
        services.tokenWeight.weightOf(orbitOf(dao), account.accountId),
        services.tokenWeight.stakingUser(dao.stakingId, account.accountId),
      ]);
      lines.push(`${token.symbol} in your account: ${fmt(balance)}`, `Voting weight: ${fmt(weight)}`);
      if (user) {
        const staked = BigInt(user.vote_amount);
        const delegated = user.delegated_amounts.reduce((sum, [, amount]) => sum + BigInt(amount), 0n);
        lines.push(`Staked: ${fmt(staked)} (${fmt(staked - delegated)} not delegated)`);
        const unlocks = BigInt(user.next_action_timestamp);
        if (unlocks > BigInt(Date.now()) * 1_000_000n) lines.push(`Unstaked tokens unlock at ${formatTime(unlocks)}`);
      }
    }
    return reply(lines.join("\n"), { ephemeral: true });
  },
};

const stake = {
  section: "Your wallet",
  usage: "<amount>",
  description: "Stake tokens; staked tokens are your voting weight",
  options: [{ name: "amount", description: "How many tokens", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const amount = parseAmount(ctx.args[0], token.decimals, `${ctx.cmd("stake")} <amount>`);
    const account = await userAccount(ctx);
    const balance = await services.tokenWeight.tokenBalance(token.id, account.accountId);
    if (balance < amount) {
      throw new UserError(`You have ${fromUnits(balance, token.decimals)} ${token.symbol}. Your account is \`${account.accountId}\`; send tokens there first.`);
    }
    await services.tokenWeight.stake(account, token.id, dao.stakingId, amount);
    const weight = await services.tokenWeight.weightOf(orbitOf(dao), account.accountId);
    return reply(`✅ Staked ${ctx.args[0]} ${token.symbol}. Your voting weight is now ${fromUnits(weight, token.decimals)}.`);
  },
};

const unstake = {
  section: "Your wallet",
  usage: "<amount>",
  description: "Remove voting weight; the tokens unlock after the unstake period",
  options: [{ name: "amount", description: "How many tokens", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const amount = parseAmount(ctx.args[0], token.decimals, `${ctx.cmd("unstake")} <amount>`);
    const account = await userAccount(ctx);
    await services.tokenWeight.unstake(account, dao.stakingId, amount);
    const user = await services.tokenWeight.stakingUser(dao.stakingId, account.accountId);
    return reply(`✅ Unstaked ${ctx.args[0]} ${token.symbol}. Withdraw them with \`${ctx.cmd("withdraw")} ${ctx.args[0]}\` after ${formatTime(user.next_action_timestamp)}.`);
  },
};

const withdraw = {
  section: "Your wallet",
  usage: "<amount>",
  description: "Return unstaked, unlocked tokens to your account",
  options: [{ name: "amount", description: "How many tokens", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const amount = parseAmount(ctx.args[0], token.decimals, `${ctx.cmd("withdraw")} <amount>`);
    const account = await userAccount(ctx);
    await services.tokenWeight.withdraw(account, dao.stakingId, amount);
    return reply(`✅ Withdrew ${ctx.args[0]} ${token.symbol} to \`${account.accountId}\`.`);
  },
};

// --- The DAO ---

const daoInfo = {
  section: "The DAO",
  usage: "",
  description: "The DAO, its orbit and voting rules",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const [config, total, threshold, governing] = await Promise.all([
      services.tokenWeight.getConfig(orbitOf(dao)),
      services.tokenWeight.totalWeight(orbitOf(dao)),
      services.tokenWeight.getThreshold(orbitOf(dao)),
      services.core.governingOrbits(dao.daoId),
    ]);
    const fmt = (u) => `${fromUnits(u, token.decimals)} ${token.symbol}`;
    const [num, denom] = config.threshold;
    const lines = [
      `*DAO:* \`${dao.daoId}\` (Sputnik)`,
      `*Governed by:* \`${dao.orbitId}\` (token weight)`,
      `*Voting token:* \`${token.id}\` (${token.symbol})`,
      "",
      `Staked weight: ${fmt(total)}`,
      `To pass: more than ${num}/${denom} of staked weight${BigInt(config.quorum) > 0n ? `, and at least ${fmt(config.quorum)}` : ""} — now ${fmt(threshold)}`,
      `Voting period: ${formatDuration(config.voting_period)}`,
    ];
    if (BigInt(config.min_proposer_weight) > 0n) lines.push(`Needed to propose: ${fmt(config.min_proposer_weight)} of weight`);
    if (!governing.includes(dao.orbitId)) {
      lines.push("", `⚠️ The DAO is now governed by ${governing.map((g) => `\`${g}\``).join(", ")}, not this chat's orbit. An admin should run \`${ctx.cmd("link")}\` again.`);
    }
    return reply(lines.join("\n"));
  },
};

const treasury = {
  section: "The DAO",
  usage: "",
  description: "What the DAO holds",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const [near, tokens] = await Promise.all([services.core.treasuryNear(dao.daoId), services.tokenWeight.tokenBalance(token.id, dao.daoId)]);
    return reply(`*Treasury of* \`${dao.daoId}\`\nNEAR: ${formatNear(near)}\n${token.symbol}: ${fromUnits(tokens, token.decimals)}`);
  },
};

/** A proposal's one-paragraph summary. */
async function describeProposal(dao, p, token) {
  const action = kinds.describeKind(p.kind, {
    formatNear,
    formatToken: (id, amount) => (id === token.id ? `${fromUnits(amount, token.decimals)} ${token.symbol}` : amount),
  });
  const fmt = (u) => fromUnits(u, token.decimals);
  const lines = [
    `*#${p.id}* — ${p.description}`,
    `Action: ${action}`,
    `Status: *${p.status}*${p.sending ? " (executing...)" : ""}`,
    `For ${fmt(p.approve)} · Against ${fmt(p.reject)} · ${p.voters} voter${p.voters === 1 ? "" : "s"}`,
  ];
  if (p.status === "InProgress") lines.push(`Voting ends ${formatTime(p.voting_ends)}`);
  if (p.core_proposal_id !== null && p.core_proposal_id !== undefined) {
    const coreProposal = await services.core.getCoreProposal(dao.daoId, p.core_proposal_id).catch(() => null);
    lines.push(`On the DAO: proposal ${p.core_proposal_id}${coreProposal ? `, ${coreProposal.status}` : ""}`);
  }
  return lines.join("\n");
}

const proposals = {
  section: "The DAO",
  usage: "",
  description: "The latest proposals",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const count = await services.tokenWeight.getProposalCount(orbitOf(dao));
    if (count === 0) return reply(`No proposals yet. Make one with \`${ctx.cmd("pay")}\` or \`${ctx.cmd("signal")}\`.`);
    const from = Math.max(0, count - 10);
    const list = await services.tokenWeight.getProposals(orbitOf(dao), from, 10);
    const lines = list.reverse().map((p) => `#${p.id} *${p.status}* — ${p.description}`);
    return reply([`*Proposals* (latest ${list.length} of ${count})`, ...lines, "", `Details: \`${ctx.cmd("proposal")} <id>\``].join("\n"));
  },
};

const proposal = {
  section: "The DAO",
  usage: "<id>",
  description: "One proposal: action, votes and status",
  options: [{ name: "id", description: "Proposal number", required: true, type: "integer" }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const id = parseId(ctx.args[0], `${ctx.cmd("proposal")} <id>`);
    const p = await services.tokenWeight.getProposal(orbitOf(dao), id);
    if (!p) throw new UserError(`There's no proposal #${id}.`);
    return reply(await describeProposal(dao, p, await tokenInfo(dao)), { buttons: proposalButtons(id, p.status) });
  },
};

// --- Proposing ---

async function makeProposal(ctx, dao, description, kind) {
  if (!description) throw new UserError("Add a description after the details, so voters know what it's for.");
  const account = await userAccount(ctx);
  const id = await services.tokenWeight.propose(account, orbitOf(dao), description, kind);
  const p = await services.tokenWeight.getProposal(orbitOf(dao), id);
  return reply(`📝 New proposal\n\n${await describeProposal(dao, p, await tokenInfo(dao))}`, { buttons: proposalButtons(id, p.status) });
}

const pay = {
  section: "Proposing",
  usage: "<amount> <NEAR|token> <account> <description>",
  description: "Propose paying from the treasury",
  options: [
    { name: "amount", description: "How much", required: true },
    { name: "currency", description: "NEAR, or the DAO's token symbol", required: true },
    { name: "to", description: "Receiving NEAR account", required: true },
    { name: "description", description: "What it's for", required: true, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("pay")} <amount> <NEAR|token> <account> <description>`;
    const [rawAmount, currency, rawTo, ...words] = ctx.args;
    const to = parseAccountId(rawTo, usage);
    const token = await tokenInfo(dao);
    let kind;
    if (currency?.toUpperCase() === "NEAR") {
      kind = kinds.transferNear(to, parseAmount(rawAmount, NEAR_DECIMALS, usage));
    } else if (currency?.toUpperCase() === token.symbol.toUpperCase() || currency === token.id) {
      kind = kinds.transferToken(token.id, to, parseAmount(rawAmount, token.decimals, usage));
    } else {
      throw new UserError(`Pay in NEAR or ${token.symbol}. Usage: \`${usage}\``);
    }
    return makeProposal(ctx, dao, words.join(" "), kind);
  },
};

const signal = {
  section: "Proposing",
  usage: "<question or statement>",
  description: "Propose a decision with nothing to execute",
  options: [{ name: "text", description: "The question or statement", required: true, rest: true }],
  async run(ctx) {
    const dao = requireDao(ctx);
    return makeProposal(ctx, dao, ctx.args.join(" "), kinds.signal());
  },
};

const swap = {
  section: "Proposing",
  usage: "<new orbit> <description>",
  description: "Propose handing the DAO to a different governance orbit",
  options: [
    { name: "orbit", description: "The new orbit, already bound to this DAO", required: true },
    { name: "description", description: "Why", required: true, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("swap")} <new orbit> <description>`;
    const newOrbit = parseAccountId(ctx.args[0], usage);
    if (newOrbit === dao.orbitId) throw new UserError("That's the orbit governing the DAO now.");
    // The orbit checks this again before executing; checking now saves a wasted vote.
    const boundTo = await services.tokenWeight.getDao(newOrbit).catch(() => null);
    if (boundTo !== dao.daoId) throw new UserError(`\`${newOrbit}\` isn't an orbit bound to \`${dao.daoId}\`. Deploy and set it up first.`);
    return makeProposal(ctx, dao, ctx.args.slice(1).join(" "), kinds.swap(newOrbit));
  },
};

// --- Deciding ---

const vote = {
  section: "Deciding",
  usage: "<id> for|against",
  description: "Vote with your staked weight",
  options: [
    { name: "id", description: "Proposal number", required: true, type: "integer" },
    { name: "choice", description: "for or against", required: true, choices: ["for", "against"] },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("vote")} <id> for|against`;
    const id = parseId(ctx.args[0], usage);
    const choice = { for: "Approve", against: "Reject" }[ctx.args[1]?.toLowerCase()];
    if (!choice) throw new UserError(`Usage: \`${usage}\``);
    const account = await userAccount(ctx);
    const status = await services.tokenWeight.vote(account, orbitOf(dao), id, choice);
    const p = await services.tokenWeight.getProposal(orbitOf(dao), id);
    const outcome = {
      Passed: p.sending ? " It passed and is being executed on the DAO." : ` It passed. Run \`${ctx.cmd("execute")} ${id}\` to execute it.`,
      Rejected: " It was rejected.",
      Expired: " Voting had already ended, so the proposal expired and your vote wasn't counted.",
    }[status] ?? "";
    return reply(`🗳 Voted *${ctx.args[1].toLowerCase()}* on #${id}.${outcome}`, { buttons: proposalButtons(id, p.status) });
  },
};

const execute = {
  section: "Deciding",
  usage: "<id>",
  description: "Execute a passed proposal on the DAO",
  options: [{ name: "id", description: "Proposal number", required: true, type: "integer" }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const id = parseId(ctx.args[0], `${ctx.cmd("execute")} <id>`);
    const account = await userAccount(ctx);
    await services.tokenWeight.execute(account, orbitOf(dao), id);
    const p = await services.tokenWeight.getProposal(orbitOf(dao), id);
    if (p.status === "Executed") return reply(`▶️ #${id} was approved on the DAO and executed.`, { buttons: proposalButtons(id, p.status) });
    return reply(`#${id} couldn't be executed on the DAO yet (status ${p.status}). Check \`${ctx.cmd("proposal")} ${id}\`, and try again in a minute.`);
  },
};

const finalize = {
  section: "Deciding",
  usage: "<id>",
  description: "Close a proposal whose voting period is over",
  options: [{ name: "id", description: "Proposal number", required: true, type: "integer" }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const id = parseId(ctx.args[0], `${ctx.cmd("finalize")} <id>`);
    const account = await userAccount(ctx);
    await services.tokenWeight.finalize(account, orbitOf(dao), id);
    return reply(`#${id} expired without passing.`);
  },
};

export const COMMANDS = {
  help,
  link,
  unlink,
  wallet,
  stake,
  unstake,
  withdraw,
  dao: daoInfo,
  treasury,
  proposals,
  proposal,
  pay,
  signal,
  swap,
  vote,
  execute,
  finalize,
};

/** Linking decides what the whole chat operates, so only admins may (re)link or unlink. */
export const ADMIN_COMMANDS = new Set(["link", "unlink"]);

/** Contract errors people can hit, in words. */
const CHAIN_ERRORS = {
  ERR_ALREADY_VOTED: "You've already voted on this proposal.",
  ERR_NO_WEIGHT: "You have no voting weight here. Stake tokens first with {stake}.",
  ERR_PROPOSAL_NOT_IN_PROGRESS: "Voting on this proposal is over.",
  ERR_NO_PROPOSAL: "There's no such proposal.",
  ERR_NOT_ENOUGH_WEIGHT_TO_PROPOSE: "You need more staked weight to make a proposal here.",
  ERR_KIND_LOCKS_CORE: "That proposal would lock the DAO, so the orbit refuses it.",
  ERR_ALREADY_SENDING: "It's already being executed. Check again in a minute.",
  ERR_PROPOSAL_NOT_PASSED: "That proposal hasn't passed.",
  ERR_VOTING_NOT_OVER: "Voting on that proposal is still open.",
  ERR_NOT_ENOUGH_TIME_PASSED: "Your unstaked tokens are still locked. {wallet} shows when they unlock.",
  ERR_NOT_ENOUGH_AMOUNT: "You don't have that much staked.",
  ERR_NOT_ENOUGH_AVAILABLE_AMOUNT: "You don't have that much unstaked and unlocked. Unstake first with {unstake}.",
  ERR_NO_DELEGATE: "You have nothing staked to unstake.",
};

/**
 * Runs one command and always returns a reply, never throws. Errors are
 * always private.
 */
export async function runCommand(name, ctx) {
  const command = COMMANDS[name];
  if (!command) return reply(`Unknown command \`${name}\`. Try \`${ctx.cmd("help")}\`.`, { ephemeral: true });
  if (ADMIN_COMMANDS.has(name) && !ctx.isDirect && ctx.isAdmin !== true) {
    return reply(ctx.isAdmin === undefined ? "Couldn't confirm you're an admin here - try again in a moment." : "Only this chat's admins can link or unlink its DAO.", { ephemeral: true });
  }
  try {
    const result = await command.run({ ...ctx, command: name });
    return { ...result, ephemeral: result.ephemeral ?? Boolean(command.ephemeralByDefault) };
  } catch (err) {
    if (err instanceof UserError) return reply(err.message, { ephemeral: true });
    if (err instanceof ChainError && CHAIN_ERRORS[err.code]) {
      const text = CHAIN_ERRORS[err.code].replace(/\{(\w+)\}/g, (_, n) => `\`${ctx.cmd(n)}\``);
      return reply(text, { ephemeral: true });
    }
    console.error(`[${ctx.platform}] ${name} failed:`, err);
    return reply(`Couldn't complete \`${name}\`: ${err.message || "unknown error"}`, { ephemeral: true });
  }
}
