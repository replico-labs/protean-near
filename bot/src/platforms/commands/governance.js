import * as kinds from "../../near/kinds.js";
import { fromUnits } from "../../near/amounts.js";
import { MODELS, isCoreBoard, isCouncilModel, takesMembers } from "../../near/models.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount, parseAccountId, parseId, tokenInfo, explain, formatTime, formatDuration, nowNs } from "../helpers.js";
import { describeProposal, loadProposal, syncGovernance } from "../proposals.js";
import { proposalCreated } from "../../proposalPages.js";
import { markAnnounced } from "../notifier.js";
import { makeProposal } from "./proposing.js";

/**
 * Changing how the DAO is run: minting its capped token, a board's members,
 * switching to a new token, and a guard (signers who confirm what passes
 * before it runs). Everything is a proposal; the change is one action on
 * the core (or the guard) when it executes.
 */

const MODEL_NAMES = Object.keys(MODELS);
const modelName = (raw) => MODEL_NAMES.find((m) => m.toLowerCase() === String(raw ?? "").toLowerCase());
const DURATION = /^(\d+(?:\.\d+)?)(m|h|d)$/i;
const NS = { m: 60_000_000_000, h: 3_600_000_000_000, d: 86_400_000_000_000 };

/** "30d", "12h", "90m" in nanoseconds, or null. */
export function parseDuration(raw) {
  const m = DURATION.exec(String(raw ?? ""));
  return m ? BigInt(Math.round(Number(m[1]) * NS[m[2].toLowerCase()])) : null;
}

/** "1", "0.5", "2.25": a ratio as [numerator, denominator] in raw units, or null. */
export function parseRatio(raw) {
  const m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(String(raw ?? ""));
  if (!m) return null;
  const fraction = m[2] ?? "";
  const numerator = BigInt(m[1] + fraction);
  return numerator > 0n ? [numerator, 10n ** BigInt(fraction.length)] : null;
}

async function membersFrom(ctx, words, usage) {
  const members = [];
  for (const word of words) members.push(await parseAccountId(ctx, word, usage));
  return [...new Set(members)];
}

/**
 * Proposes `kind`, a change of governance, and remembers what it prepared
 * under `pending` so the chat follows once it executes.
 */
async function proposeChange(ctx, dao, description, kind, pending, headline) {
  const account = await userAccount(ctx);
  const id = await explain(
    () => (isCoreBoard(dao) ? services.core.addProposal(account, dao.daoId, description, kind) : services.orbit.propose(account, dao.orbitId, description, kind)),
    { ERR_NOT_COUNCIL_MEMBER: "Only council or board members can propose in this DAO.", ERR_PERMISSION_DENIED: "Only the board's members can propose." }
  );
  services.db.setChatDao(ctx.platform, ctx.chatId, { ...services.db.getChatDao(ctx.platform, ctx.chatId), ...pending(id) });
  const token = await tokenInfo(dao);
  const p = await loadProposal(dao, id, token);
  if (!isCoreBoard(dao)) markAnnounced(ctx.platform, ctx.chatId, id, p.state);
  return reply(`${headline}\n\n${describeProposal(p, token)}`, { buttons: p.buttons, private: await proposalCreated(ctx, dao, id) });
}

/**
 * How a passed change hands the DAO to `target`: a swap on the core, or
 * behind a guard, an instruction moving the guard to `target`.
 */
const handTo = (dao, target) => (dao.guardId ? kinds.setGovernance(dao.guardId, target) : kinds.swap(target));

// --- Token ---

const mint = {
  section: "Proposing",
  needsDao: true,
  usage: "<amount> <account> <description>",
  description: "Propose minting new tokens, up to the token's cap",
  options: [
    { name: "amount", description: "How many tokens", required: true },
    { name: "to", description: "Who receives them: a NEAR account, or me", required: true },
    { name: "description", description: "What they're for", required: true, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("mint")} <amount> <account> <description>`;
    const token = await tokenInfo(dao);
    const amount = parseAmount(ctx.args[0], token.decimals, usage);
    const to = await parseAccountId(ctx, ctx.args[1], usage);
    const supply = await services.staking.getSupply(token.id);
    if (!supply || supply.minter !== dao.daoId) throw new UserError(`${token.symbol} has a fixed supply: nothing more can be minted.`);
    if (amount > supply.mintable) throw new UserError(`Only ${token.format(supply.mintable)} more can ever be minted (cap ${token.format(supply.maxSupply)}, ${token.format(supply.totalMinted)} minted so far, burned tokens included).`);
    return makeProposal(ctx, dao, ctx.args.slice(2).join(" "), kinds.mint(token.id, to, amount));
  },
};

const changetoken = {
  section: "Setup",
  needsDao: true,
  usage: "<SYMBOL> <ratio> [cap] [model] [members...]",
  description: "Propose moving the DAO to a new token: holders swap old for new at the ratio",
  options: [
    { name: "symbol", description: "The new token's symbol", required: true },
    { name: "ratio", description: "New tokens per old token, e.g. 1 or 0.5", required: true },
    { name: "cap", description: "Most that can ever be minted (leave out for a fixed supply)", required: false },
    { name: "model", description: "Governance model on the new token (default: the current one)", required: false, choices: MODEL_NAMES },
    { name: "members", description: "A board's members, or a starting council", required: false, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("changetoken")} <SYMBOL> <ratio> [cap] [model] [members...]`;
    const [symbol, rawRatio, ...rest] = ctx.args;
    if (!/^[A-Za-z0-9]{2,10}$/.test(symbol ?? "")) throw new UserError(`The symbol must be 2-10 letters or digits. Usage: \`${usage}\``);
    const ratio = parseRatio(rawRatio);
    if (!ratio) throw new UserError(`The ratio is how many new tokens each old one becomes, like 1 or 0.5. Usage: \`${usage}\``);
    const cap = /^\d/.test(rest[0] ?? "") ? parseAmount(rest.shift(), 18, usage) : null;
    const model = rest.length && modelName(rest[0]) ? modelName(rest.shift()) : isCoreBoard(dao) ? "board" : dao.model;
    let members = await membersFrom(ctx, rest, usage);
    if (model === "board" && !members.length) {
      members = isCoreBoard(dao) ? await services.core.governingMembers(dao.daoId) : dao.model === "board" ? await services.orbit.getCouncil(dao.orbitId) : [];
      if (!members.length) throw new UserError(`A board needs its members: \`${usage}\``);
    }
    if (members.length && !takesMembers(model)) throw new UserError("Only board, delegate and sortition take members.");
    if (dao.pendingTokenChange) throw new UserError(`Proposal #${dao.pendingTokenChange.proposalId} already proposes a token change.`);

    const prepared = await services.deploy.createTokenChange({
      name: dao.name ?? dao.daoId.split(".")[0],
      daoId: dao.daoId,
      oldTokenId: dao.tokenId,
      symbol: symbol.toUpperCase(),
      numerator: ratio[0],
      denominator: ratio[1],
      cap,
      model,
      council: members,
    });
    const old = await tokenInfo(dao);
    const description = `Change the DAO's token from ${old.symbol} to ${symbol.toUpperCase()} at ${rawRatio}:1, governed by ${model} (${prepared.orbitId})`;
    const pending = (id) => ({ pendingTokenChange: { ...prepared, supply: String(prepared.supply), symbol: symbol.toUpperCase(), model, proposalId: id } });
    return proposeChange(
      ctx,
      dao,
      description,
      handTo(dao, prepared.orbitId),
      pending,
      `🪙 Proposed moving to *${symbol.toUpperCase()}*. Its token, staking vault, migrator and a *${model}* orbit are ready; they take over if this passes. Each ${old.symbol} will swap for ${rawRatio} ${symbol.toUpperCase()}.`
    );
  },
};

const migrate = {
  section: "Your wallet",
  needsDao: true,
  usage: "<amount|all> [keep]",
  description: "After a token change, swap your old tokens for the new one (staked for you, or `keep` to hold them)",
  options: [
    { name: "amount", description: "How many old tokens, or all (your stake in the old vault too)", required: true },
    { name: "keep", description: "keep: hold the new tokens instead of staking them", required: false, choices: ["keep"] },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("migrate")} <amount|all> [keep]`;
    if (!dao.migration) throw new UserError("This DAO hasn't changed its token, so there's nothing to swap.");
    const { oldTokenId, oldStakingId, migratorId } = dao.migration;
    const [oldMeta, token] = await Promise.all([services.staking.tokenMetadata(oldTokenId), tokenInfo(dao)]);
    const oldFormat = (units) => `${fromUnits(units, oldMeta.decimals)} ${oldMeta.symbol}`;
    const account = await userAccount(ctx);
    let unstaked = "";
    let amount;
    if (String(ctx.args[0]).toLowerCase() === "all") {
      const member = await services.staking.getMember(oldStakingId, account.accountId);
      if (member?.available > 0n) {
        await services.staking.unstake(account, oldStakingId, member.available);
        unstaked = " (your old stake included)";
      }
      amount = await services.staking.tokenBalance(oldTokenId, account.accountId);
    } else {
      amount = parseAmount(ctx.args[0], oldMeta.decimals, usage);
      const balance = await services.staking.tokenBalance(oldTokenId, account.accountId);
      if (balance < amount) throw new UserError(`You have ${oldFormat(balance)} unstaked. \`${ctx.cmd("migrate")} all\` unstakes your old stake too.`);
    }
    if (amount <= 0n) throw new UserError(`You have no ${oldMeta.symbol} to swap.`);
    const out = await services.staking.migrationQuote(migratorId, amount);
    const keep = String(ctx.args[1] ?? "").toLowerCase() === "keep";
    await explain(() => services.staking.migrate(account, { oldTokenId, newTokenId: token.id, migratorId, stakeIn: keep ? null : dao.stakingId }, amount), {
      ERR_AMOUNT_TOO_SMALL: "That's too little to swap for any of the new token.",
    });
    return reply(`🪙 Swapped your ${oldMeta.symbol}${unstaked} for ${token.format(out)}${keep ? "." : `, staked in the new vault: it counts on proposals made from now on.`}`);
  },
};

// --- Board ---

const setboard = {
  section: "Setup",
  needsDao: true,
  models: ["board"],
  usage: "<quorum> <members...>",
  description: "Propose new board members, and how many must vote",
  options: [
    { name: "quorum", description: "Members who must vote on a proposal", required: true, type: "integer" },
    { name: "members", description: "NEAR accounts, or me", required: true, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("setboard")} <quorum> <members...>`;
    if (isCoreBoard(dao)) throw new UserError(`This board approves on the DAO itself. Move it to a board orbit first: \`${ctx.cmd("switchmodel")} board <members...>\`.`);
    const quorum = parseId(ctx.args[0], usage);
    const members = await membersFrom(ctx, ctx.args.slice(1), usage);
    if (!members.length || quorum < 1 || quorum > members.length) throw new UserError(`The quorum must be between 1 and the number of members. Usage: \`${usage}\``);
    return makeProposal(ctx, dao, `Set the board to ${members.join(", ")}, ${quorum} to vote`, kinds.setBoard(dao.orbitId, members, quorum));
  },
};

// --- Guard ---

const STATE_ICON = { Pending: "⏳", Confirmed: "✅", Executed: "▶️", Rejected: "❌", Expired: "⌛" };

async function guardSummary(dao) {
  const config = await services.guard.getConfig(dao.guardId);
  const count = await services.guard.getInstructionCount(dao.guardId);
  const recent = count ? await services.guard.getInstructions(dao.guardId, Math.max(0, count - 5), 5) : [];
  const lines = [
    `🛡 *Guard* \`${dao.guardId}\``,
    `Signers (${config.threshold} of ${config.signers.length} confirm): ${config.signers.map((s) => `\`${s}\``).join(", ")}`,
    BigInt(config.tenure_end) > nowNs() ? `They serve until ${formatTime(config.tenure_end)}; governance can replace them after that.` : "Their tenure is over: governance can replace them now.",
  ];
  if (recent.length) lines.push("", ...recent.reverse().map((i) => `${STATE_ICON[i.state] ?? ""} #${i.id} ${i.description} — ${i.state}${i.state === "Pending" ? `, ${i.confirmations}/${config.threshold}` : ""}`));
  const buttons = recent.filter((i) => i.state === "Pending").slice(0, 3).map((i) => [{ label: `✅ Confirm #${i.id}`, cmd: `confirm ${i.id}` }, { label: `❌ Reject #${i.id}`, cmd: `reject ${i.id}` }]);
  return { text: lines.join("\n"), buttons };
}

/** The guard's lines for /dao. */
export async function guardLines(dao) {
  const config = await services.guard.getConfig(dao.guardId).catch(() => null);
  if (!config) return [];
  return [`🛡 *Guard:* \`${dao.guardId}\`: ${config.threshold} of ${config.signers.length} signers confirm what passes before it runs.`];
}

const guard = {
  section: "Setup",
  needsDao: true,
  usage: "[on <threshold> <tenure> <signers...> | off]",
  description: "Signers who confirm what passes before it runs: status, or propose turning it on or off",
  options: [
    { name: "action", description: "on or off; leave out for the status", required: false, choices: ["on", "off"] },
    { name: "threshold", description: "Signers who must confirm", required: false, type: "integer" },
    { name: "tenure", description: "How long signers serve before they can be replaced, e.g. 30d", required: false },
    { name: "signers", description: "NEAR accounts, or me", required: false, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("guard")} on <threshold> <tenure, e.g. 30d> <signers...>`;
    const action = String(ctx.args[0] ?? "").toLowerCase();
    if (!action) {
      if (!dao.guardId) return reply(`This DAO has no guard. Propose one with \`${usage}\`.`);
      const { text, buttons } = await guardSummary(dao);
      return reply(text, { buttons });
    }
    if (isCoreBoard(dao)) throw new UserError(`A guard sits in front of an orbit. Move this board to a board orbit first: \`${ctx.cmd("switchmodel")} board <members...>\`.`);
    if (action === "off") {
      if (!dao.guardId) throw new UserError("This DAO has no guard.");
      // The core goes back to the orbit; the guard's signers confirm it like anything else.
      return proposeChange(ctx, dao, `Turn the guard off: hand the DAO back to ${dao.orbitId}`, kinds.swap(dao.orbitId), () => ({}), "🛡 Proposed turning the guard off. If it passes, the signers confirm it like anything else.");
    }
    if (action !== "on") throw new UserError(`Usage: \`${usage}\` or \`${ctx.cmd("guard")} off\``);
    if (dao.guardId) throw new UserError("This DAO already has a guard.");
    if (!(await services.versions.orbitKnowsGuards(dao.orbitId)))
      throw new UserError(
        `This DAO's orbit is from before guards and couldn't send anything through one: behind a guard, nothing it passed could ever run. Move it to today's code first with \`${ctx.cmd("switchmodel")} ${dao.model}\` (same model, same stakes), then turn the guard on.`
      );
    const threshold = parseId(ctx.args[1], usage);
    const tenure = parseDuration(ctx.args[2]);
    if (!tenure) throw new UserError(`The tenure is how long signers serve, like 30d, 12h or 90m. Usage: \`${usage}\``);
    const signers = await membersFrom(ctx, ctx.args.slice(3), usage);
    if (!signers.length || threshold < 1 || threshold > signers.length) throw new UserError(`The threshold must be between 1 and the number of signers. Usage: \`${usage}\``);
    const ttl = BigInt(process.env.GUARD_INSTRUCTION_MINUTES ?? 7 * 24 * 60) * 60_000_000_000n;
    const guardId = await services.deploy.createGuard({ name: dao.name ?? dao.daoId.split(".")[0], daoId: dao.daoId, governance: dao.orbitId, signers, threshold, tenureNs: tenure, ttlNs: ttl });
    return proposeChange(
      ctx,
      dao,
      `Turn on a guard (${guardId}): ${threshold} of ${signers.join(", ")} confirm what passes`,
      kinds.swap(guardId),
      (id) => ({ pendingGuard: { guardId, proposalId: id } }),
      `🛡 Proposed a guard: ${threshold} of ${signers.length} signers would confirm every passed proposal before it runs, serving ${formatDuration(tenure)} before they can be replaced. The guard \`${guardId}\` is ready and takes over if this passes.`
    );
  },
};

const signers = {
  section: "Setup",
  needsDao: true,
  usage: "<threshold> <signers...>",
  description: "Propose new guard signers; it takes effect only after the current signers' tenure",
  options: [
    { name: "threshold", description: "Signers who must confirm", required: true, type: "integer" },
    { name: "signers", description: "NEAR accounts, or me", required: true, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("signers")} <threshold> <signers...>`;
    if (!dao.guardId) throw new UserError("This DAO has no guard.");
    const threshold = parseId(ctx.args[0], usage);
    const list = await membersFrom(ctx, ctx.args.slice(1), usage);
    if (!list.length || threshold < 1 || threshold > list.length) throw new UserError(`The threshold must be between 1 and the number of signers. Usage: \`${usage}\``);
    const config = await services.guard.getConfig(dao.guardId);
    const note = BigInt(config.tenure_end) > nowNs() ? `\n\n⏳ The current signers serve until ${formatTime(config.tenure_end)}; it can only be executed after that.` : "";
    const result = await makeProposal(ctx, dao, `Replace the guard's signers with ${list.join(", ")}, ${threshold} to confirm`, kinds.setSigners(dao.guardId, list, threshold));
    return { ...result, text: result.text + note };
  },
};

const GUARD_ERRORS = {
  ERR_NOT_SIGNER: "Only the guard's signers can do that.",
  ERR_NOT_PENDING: "That instruction isn't waiting for signers any more.",
  ERR_ALREADY_VOTED: "You've already voted on that instruction.",
  ERR_NOT_VOTED: "You haven't voted on that instruction.",
  ERR_NO_INSTRUCTION: "There's no such instruction.",
  ERR_NOT_CONFIRMED: "That instruction isn't confirmed.",
};

function signerAction(name, description, act, verb) {
  return {
    section: "Deciding",
    needsDao: true,
    usage: "<instruction>",
    description,
    options: [{ name: "id", description: "Instruction number", required: true, type: "integer" }],
    async run(ctx) {
      const dao = requireDao(ctx);
      if (!dao.guardId) throw new UserError("This DAO has no guard.");
      const id = parseId(ctx.args[0], `${ctx.cmd(name)} <instruction>`);
      const account = await userAccount(ctx);
      await explain(() => act(account, dao.guardId, id), GUARD_ERRORS);
      const i = await services.guard.getInstruction(dao.guardId, id);
      const synced = i.state === "Executed" ? await syncGovernance(ctx.platform, ctx.chatId, account) : "";
      const ran = i.state === "Executed" ? " Enough signers confirmed, and it ran on the DAO." : i.state === "Confirmed" ? ` It's confirmed but didn't run yet: \`${ctx.cmd("resend")} ${id}\` tries again.` : "";
      return reply(`🛡 ${verb} instruction #${id}: ${i.description}.${ran}${synced}`);
    },
  };
}

const confirm = signerAction("confirm", "As a guard signer, confirm an instruction", (...a) => services.guard.confirm(...a), "Confirmed");
const reject = signerAction("reject", "As a guard signer, reject an instruction", (...a) => services.guard.reject(...a), "Rejected");
const revoke = signerAction("revoke", "As a guard signer, take back your vote on an instruction", (...a) => services.guard.revoke(...a), "Took back your vote on");
const resend = signerAction("resend", "Run a confirmed guard instruction on the DAO again, if it failed", (...a) => services.guard.send(...a), "Sent");

export const GOVERNANCE_COMMANDS = { mint, changetoken, migrate, setboard, guard, signers, confirm, reject, revoke, resend };
