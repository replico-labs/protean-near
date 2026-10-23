import { NEAR_DECIMALS } from "../../near/amounts.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseId, parseAmount, tokenInfo, formatNear, explain } from "../helpers.js";
import { loadProposal, describeProposal } from "../proposals.js";

const idOption = [{ name: "id", description: "Proposal number", required: true, type: "integer" }];
const outcomeOf = (raw, usage) => {
  const o = { success: "Success", yes: "Success", failure: "Failure", fail: "Failure", no: "Failure" }[String(raw).toLowerCase()];
  if (!o) throw new UserError(`Usage: \`${usage}\``);
  return o;
};

async function show(ctx, dao, id, headline) {
  const token = await tokenInfo(dao);
  const p = await loadProposal(dao, id, token);
  return reply(`${headline}\n\n${describeProposal(p, token)}`, { buttons: p.buttons });
}

/** The model's settings from the orbit. */
async function settings(dao) {
  return services.orbit.modelOf(await services.orbit.getModel(dao.orbitId)).settings;
}

/** Sends `amount` of the DAO's token to the orbit with `msg`, after checking the caller holds it. */
async function sendTokens(ctx, dao, amount, msg, what) {
  const token = await tokenInfo(dao);
  const account = await userAccount(ctx);
  const balance = await services.staking.tokenBalance(token.id, account.accountId);
  if (balance < amount) throw new UserError(`${what} takes ${token.format(amount)}; you have ${token.format(balance)} unstaked.`);
  await services.orbit.sendToOrbit(account, token.id, dao.orbitId, amount, msg);
  return { account, token };
}

// --- Sowellian ---

const SOWELLIAN = ["sowellian"];

const position = {
  section: "Markets",
  usage: "<id> yes|no <amount>",
  description: "Bet tokens on whether an approved proposal will succeed",
  models: SOWELLIAN,
  options: [...idOption, { name: "side", description: "yes or no", required: true, choices: ["yes", "no"] }, { name: "amount", description: "Tokens", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("position")} <id> yes|no <amount>`;
    const id = parseId(ctx.args[0], usage);
    const side = { yes: "Yes", no: "No" }[String(ctx.args[1]).toLowerCase()];
    if (!side) throw new UserError(`Usage: \`${usage}\``);
    const token = await tokenInfo(dao);
    const amount = parseAmount(ctx.args[2], token.decimals, usage);
    const { account } = await sendTokens(ctx, dao, amount, { position: id, side }, "That position");
    const mine = await services.orbit.getPosition(dao.orbitId, id, account.accountId);
    if (!mine || BigInt(side === "Yes" ? mine.yes : mine.no) === 0n) throw new UserError("Positions aren't open on that proposal; your tokens were returned.");
    return show(ctx, dao, id, `🎲 You bet ${token.format(amount)} on *${side.toLowerCase()}* for #${id}.`);
  },
};

const proposeresolution = {
  section: "Markets",
  usage: "<id> success|failure",
  description: "Propose the measured outcome, with a resolution bond",
  models: SOWELLIAN,
  options: [...idOption, { name: "outcome", description: "success or failure", required: true, choices: ["success", "failure"] }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("proposeresolution")} <id> success|failure`;
    const id = parseId(ctx.args[0], usage);
    const outcome = outcomeOf(ctx.args[1], usage);
    const bond = BigInt((await settings(dao)).resolution_bond);
    const { account, token } = await sendTokens(ctx, dao, bond, { resolve: id, outcome }, "Resolving");
    const bet = await services.orbit.getBet(dao.orbitId, id);
    if (bet?.resolver !== account.accountId) throw new UserError("That proposal can't be resolved yet (still measuring, or already resolved); your bond was returned.");
    return reply(`⚖️ Proposed *${outcome.toLowerCase()}* for #${id} with a ${token.format(bond)} bond. Anyone can dispute it with \`${ctx.cmd("dispute")} ${id}\` until the challenge window closes.`);
  },
};

const dispute = {
  section: "Markets",
  usage: "<id>",
  description: "Dispute a proposed resolution, with a bond; stakers then adjudicate",
  models: SOWELLIAN,
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("dispute")} <id>`);
    const bond = BigInt((await settings(dao)).challenge_bond);
    const { account, token } = await sendTokens(ctx, dao, bond, { dispute: id }, "Disputing");
    const bet = await services.orbit.getBet(dao.orbitId, id);
    if (bet?.challenger !== account.accountId) throw new UserError("That resolution can't be disputed (its window closed, or it was already disputed); your bond was returned.");
    return reply(`⚔️ Disputed #${id}'s resolution with a ${token.format(bond)} bond. Stakers vote with \`${ctx.cmd("adjudicate")} ${id} success|failure\`.`);
  },
};

const adjudicate = {
  section: "Markets",
  usage: "<id> success|failure",
  description: "Vote on a disputed outcome with your stake",
  models: SOWELLIAN,
  options: [...idOption, { name: "outcome", description: "success or failure", required: true, choices: ["success", "failure"] }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("adjudicate")} <id> success|failure`;
    const id = parseId(ctx.args[0], usage);
    const outcome = outcomeOf(ctx.args[1], usage);
    const account = await userAccount(ctx);
    const weight = await explain(() => services.orbit.adjudicate(account, dao.orbitId, id, outcome), {
      ERR_NOT_ADJUDICATING: "That proposal isn't being adjudicated.",
      ERR_ADJUDICATION_CLOSED: "Adjudication is over.",
      ERR_ALREADY_VOTED: "You've already voted.",
    });
    if (BigInt(weight ?? 0) === 0n) throw new UserError("Your vote wasn't counted: you had no stake when the proposal was approved.");
    return reply(`🗳 Voted *${outcome.toLowerCase()}* on #${id}'s outcome.`);
  },
};

const finalizeresolution = {
  section: "Markets",
  usage: "<id>",
  description: "Settle the outcome: unchallenged, adjudicated, or from the oracle",
  models: SOWELLIAN,
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("finalizeresolution")} <id>`);
    const account = await userAccount(ctx);
    const bet = await services.orbit.getBet(dao.orbitId, id);
    if (!bet) throw new UserError(`There's no proposal #${id}.`);
    let outcome;
    if (bet.criteria !== "Human" && bet.criteria?.Oracle) {
      outcome = await explain(() => services.orbit.resolveViaOracle(account, dao.orbitId, id), { ERR_MEASUREMENT_NOT_OVER: "Its measurement period isn't over.", ERR_RESOLVED: "It's already resolved.", ERR_NOT_EXECUTED: "It hasn't executed yet." });
      if (!outcome) throw new UserError("The oracle had no fresh value. Try again later.");
    } else if (bet.challenger) {
      outcome = await explain(() => services.orbit.finalizeAdjudication(account, dao.orbitId, id), { ERR_ADJUDICATION_NOT_OVER: "Adjudication is still open.", ERR_RESOLVED: "It's already resolved." });
    } else {
      outcome = await explain(() => services.orbit.finalizeResolution(account, dao.orbitId, id), { ERR_CHALLENGE_WINDOW_OPEN: "Its resolution can still be disputed.", ERR_NO_RESOLUTION: "Nobody has proposed its outcome yet.", ERR_RESOLVED: "It's already resolved." });
    }
    return reply(`🏁 #${id} resolved: *${outcome.toLowerCase()}*. Winning positions collect with \`${ctx.cmd("claimposition")} ${id}\`.`);
  },
};

const claimposition = {
  section: "Markets",
  usage: "<id>",
  description: "Collect a winning (or refunded) position",
  models: SOWELLIAN,
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("claimposition")} <id>`);
    const account = await userAccount(ctx);
    const token = await tokenInfo(dao);
    const payout = await explain(() => services.orbit.claimPosition(account, dao.orbitId, id), { ERR_NO_POSITION: "You have no position on it.", ERR_CLAIMED: "You already collected it.", ERR_NOT_RESOLVED: "Its outcome isn't settled yet." });
    return reply(BigInt(payout) > 0n ? `💰 You collected ${token.format(payout)}.` : "Your side lost; there's nothing to collect.");
  },
};

const forfeitbond = {
  section: "Markets",
  usage: "<id>",
  description: "Send a rejected proposal's bond to the treasury",
  models: SOWELLIAN,
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("forfeitbond")} <id>`);
    const account = await userAccount(ctx);
    await explain(() => services.orbit.forfeitBond(account, dao.orbitId, id), { ERR_NOT_DEFEATED: "Only a rejected proposal's bond is forfeited.", ERR_NO_BOND: "Its bond was already settled." });
    return reply(`#${id}'s bond went to the treasury.`);
  },
};

// --- Decision markets ---

const DECISION = ["decisionMarkets"];

/** "NEAR" or the token symbol, as the orbit's asset name. */
function assetOf(raw, token, usage) {
  if (String(raw).toUpperCase() === "NEAR") return { asset: "Near", decimals: NEAR_DECIMALS, format: (u) => `${formatNear(u)} NEAR` };
  if (String(raw).toUpperCase() === token.symbol.toUpperCase()) return { asset: "Token", decimals: token.decimals, format: token.format };
  throw new UserError(`Use NEAR or ${token.symbol}. Usage: \`${usage}\``);
}

/** A UserError unless the caller's account can spend `amount` yoctoNEAR and still pay gas. */
async function requireNear(ctx, account, amount) {
  // The call itself holds NEAR for gas until it finishes (0.3 at testnet's gas price), on top of the amount.
  const [available, hold] = await Promise.all([services.wallets.availableBalance(account.accountId), services.wallets.gasHoldNear()]);
  const spendable = available > hold ? available - hold : 0n;
  if (spendable < amount) {
    throw new UserError(`That takes ${formatNear(amount)} NEAR; your account has ${formatNear(spendable)} spendable (it keeps ${formatNear(hold)} for gas). Send NEAR to it first (\`${ctx.cmd("wallet")}\` shows its address).`);
  }
}

const seed = {
  section: "Markets",
  usage: "<id> <tokens> <NEAR>",
  description: "Seed your proposal's two markets; trading opens once both are in",
  models: DECISION,
  options: [...idOption, { name: "tokens", description: "Token seed", required: true }, { name: "near", description: "NEAR seed", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("seed")} <id> <tokens> <NEAR>`;
    const id = parseId(ctx.args[0], usage);
    const token = await tokenInfo(dao);
    const tokens = parseAmount(ctx.args[1], token.decimals, usage);
    const near = parseAmount(ctx.args[2], NEAR_DECIMALS, usage);
    const account = await userAccount(ctx);
    // Check both sides first, so a short balance doesn't leave a half-seeded proposal.
    await requireNear(ctx, account, near);
    const balance = await services.staking.tokenBalance(token.id, account.accountId);
    if (balance < tokens) throw new UserError(`The token seed takes ${token.format(tokens)}; you have ${token.format(balance)} unstaked.`);
    await explain(() => services.orbit.seedNear(account, dao.orbitId, id, near), { ERR_NOT_PROPOSER: "Only the proposer seeds its markets.", ERR_ALREADY_SEEDED: "It's already seeded." });
    await sendTokens(ctx, dao, tokens, { seed: id }, "The token seed");
    return show(ctx, dao, id, `🌱 Seeded #${id} with ${token.format(tokens)} and ${formatNear(near)} NEAR. Trading is open.`);
  },
};

const split = {
  section: "Markets",
  usage: "<id> <amount> <NEAR|token>",
  description: "Turn NEAR or tokens into equal pass and fail units to trade",
  models: DECISION,
  options: [...idOption, { name: "amount", description: "How much", required: true }, { name: "asset", description: "NEAR or the token", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("split")} <id> <amount> <NEAR|token>`;
    const id = parseId(ctx.args[0], usage);
    const token = await tokenInfo(dao);
    const a = assetOf(ctx.args[2], token, usage);
    const amount = parseAmount(ctx.args[1], a.decimals, usage);
    if (a.asset === "Near") {
      const account = await userAccount(ctx);
      await requireNear(ctx, account, amount);
      await explain(() => services.orbit.splitNear(account, dao.orbitId, id, amount), { ERR_TRADING_CLOSED: "Trading isn't open on that proposal." });
    } else {
      await sendTokens(ctx, dao, amount, { split: id }, "Splitting");
    }
    return reply(`✂️ You now hold ${a.format(amount)} of pass units and ${a.format(amount)} of fail units on #${id}.`);
  },
};

const trade = {
  section: "Markets",
  usage: "<id> pass|fail <amount> <NEAR|token>",
  description: "Sell pass or fail units of one asset for the other in that market",
  models: DECISION,
  options: [...idOption, { name: "market", description: "pass or fail", required: true, choices: ["pass", "fail"] }, { name: "amount", description: "How much to sell", required: true }, { name: "asset", description: "What you sell: NEAR or the token", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("trade")} <id> pass|fail <amount> <NEAR|token>`;
    const id = parseId(ctx.args[0], usage);
    const side = { pass: "Pass", fail: "Fail" }[String(ctx.args[1]).toLowerCase()];
    if (!side) throw new UserError(`Usage: \`${usage}\``);
    const token = await tokenInfo(dao);
    const a = assetOf(ctx.args[3], token, usage);
    const amount = parseAmount(ctx.args[2], a.decimals, usage);
    const account = await userAccount(ctx);
    const out = await explain(() => services.orbit.trade(account, dao.orbitId, id, side, a.asset, amount), {
      ERR_NOT_ENOUGH_UNITS: `You don't hold that many ${side.toLowerCase()} units; \`${ctx.cmd("split")}\` first.`,
      ERR_TRADING_CLOSED: "Trading isn't open on that proposal.",
      ERR_SLIPPAGE: "That trade is too small to buy anything.",
    });
    const got = a.asset === "Near" ? token.format(out) : `${formatNear(out)} NEAR`;
    return show(ctx, dao, id, `📈 Sold ${a.format(amount)} in the ${side.toLowerCase()} market for ${got}.`);
  },
};

const merge = {
  section: "Markets",
  usage: "<id> <amount> <NEAR|token>",
  description: "Turn matched pass + fail units back into NEAR or tokens",
  models: DECISION,
  options: [...idOption, { name: "amount", description: "How much", required: true }, { name: "asset", description: "NEAR or the token", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const usage = `${ctx.cmd("merge")} <id> <amount> <NEAR|token>`;
    const id = parseId(ctx.args[0], usage);
    const token = await tokenInfo(dao);
    const a = assetOf(ctx.args[2], token, usage);
    const amount = parseAmount(ctx.args[1], a.decimals, usage);
    const account = await userAccount(ctx);
    await explain(() => services.orbit.merge(account, dao.orbitId, id, a.asset, amount), { ERR_NOT_ENOUGH_UNITS: "You don't hold that many matched units.", ERR_TRADING_CLOSED: "Trading is over; redeem instead." });
    return reply(`✅ Merged ${a.format(amount)} back.`);
  },
};

const redeem = {
  section: "Markets",
  usage: "<id>",
  description: "After trading, cash in your winning units",
  models: DECISION,
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("redeem")} <id>`);
    const account = await userAccount(ctx);
    const token = await tokenInfo(dao);
    const [tokens, near] = await explain(() => services.orbit.redeem(account, dao.orbitId, id), { ERR_TRADING_NOT_OVER: "Trading isn't over yet.", ERR_NOTHING_TO_REDEEM: "You hold no units there." });
    return reply(`💰 Redeemed ${token.format(tokens)} and ${formatNear(near)} NEAR.`);
  },
};

const reclaimliquidity = {
  section: "Markets",
  usage: "<id>",
  description: "After trading, return the winning market's liquidity to the proposer",
  models: DECISION,
  options: idOption,
  async run(ctx) {
    const dao = requireDao(ctx, this.models);
    const id = parseId(ctx.args[0], `${ctx.cmd("reclaimliquidity")} <id>`);
    const account = await userAccount(ctx);
    const token = await tokenInfo(dao);
    const [tokens, near] = await explain(() => services.orbit.reclaimLiquidity(account, dao.orbitId, id), { ERR_TRADING_NOT_OVER: "Trading isn't over yet.", ERR_RECLAIMED: "Already reclaimed." });
    return reply(`💧 Returned ${token.format(tokens)} and ${formatNear(near)} NEAR to the proposer.`);
  },
};

export const MARKET_COMMANDS = { position, proposeresolution, dispute, adjudicate, finalizeresolution, claimposition, forfeitbond, seed, split, trade, merge, redeem, reclaimliquidity };
