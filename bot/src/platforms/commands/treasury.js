import { NEAR_DECIMALS } from "../../near/amounts.js";
import * as kinds from "../../near/kinds.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount, tokenInfo, formatNear } from "../helpers.js";
import { makeProposal } from "./proposing.js";

/**
 * Putting the treasury to work on NEAR, by proposal: swaps on Rhea and
 * liquid staking. Each command checks the treasury can cover it, then
 * proposes it like any other action; nothing moves until it passes.
 */

const DEFAULT_SLIPPAGE_BPS = 100;
const MAX_SLIPPAGE_BPS = 5_000;

/** "NEAR", the DAO's token or a known symbol, as Rhea's token, with its metadata; or a UserError. */
async function tokenArg(raw, daoToken, usage) {
  const id = services.tokens.resolve(raw, daoToken);
  if (!id) throw new UserError(`\`${raw ?? ""}\` isn't a token I know. Use NEAR, ${daoToken.symbol}, a known symbol or a token account. Usage: \`${usage}\``);
  const meta = id === "NEAR" ? { symbol: "NEAR", decimals: NEAR_DECIMALS } : await services.tokens.info(id).catch(() => null);
  if (!meta) throw new UserError(`\`${id}\` isn't a token contract.`);
  return { id, ...meta };
}

/** The treasury's spendable balance of `token` ("NEAR" or a token account). */
async function treasuryHas(dao, token) {
  return token === "NEAR" ? services.core.availableNear(dao.daoId) : services.staking.tokenBalance(token, dao.daoId);
}

/** Basis points from "1", "0.5%" or "2%"; default 1%. */
function slippageArg(raw, usage) {
  if (raw === undefined) return DEFAULT_SLIPPAGE_BPS;
  const match = /^(\d+(?:\.\d{1,2})?)%?$/.exec(raw);
  const bps = match ? Math.round(Number(match[1]) * 100) : NaN;
  if (!(bps >= 1 && bps <= MAX_SLIPPAGE_BPS)) throw new UserError(`Slippage is a percentage from 0.01 to 50, e.g. 1 or 0.5%. Usage: \`${usage}\``);
  return bps;
}

const swap = {
  section: "Treasury",
  needsDao: true,
  usage: "<amount> <from> <to> [slippage%]",
  description: "Propose swapping treasury funds on Rhea, with a minimum output",
  options: [
    { name: "amount", description: "How much to sell", required: true },
    { name: "from", description: "NEAR, the DAO's token, a symbol like USDC, or a token account", required: true },
    { name: "to", description: "What to buy", required: true },
    { name: "slippage", description: "Most the price may move before it reverts, in % (default 1)", required: false },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("swap")} <amount> <from> <to> [slippage%]`;
    const dao = requireDao(ctx);
    const daoToken = await tokenInfo(dao);
    const [rawAmount, rawFrom, rawTo, rawSlippage] = ctx.args;
    const from = await tokenArg(rawFrom, daoToken, usage);
    const to = await tokenArg(rawTo, daoToken, usage);
    const amount = parseAmount(rawAmount, from.decimals, usage);
    const slippage = slippageArg(rawSlippage, usage);
    const fmt = (token, units) => services.tokens.format(token.id, units);

    const held = await treasuryHas(dao, from.id);
    if (held < amount) throw new UserError(`The treasury has ${fmt(from, held)}, less than ${fmt(from, amount)}.`);
    const quote = await services.rhea.quote(from.id, to.id, amount);
    if (!quote) throw new UserError(`Rhea has no liquidity between ${from.symbol} and ${to.symbol}.`);
    const minOut = services.rhea.withSlippage(quote.out, slippage);
    await userAccount(ctx); // the proposer's account, before the operator spends anything
    await services.rhea.prepareDao(dao.daoId, from.id, to.id);

    const kind = kinds.rheaSwap({
      rhea: services.rhea.exchangeId(),
      wrapNear: services.venues.wrapNear,
      tokenIn: from.id,
      amountIn: amount,
      route: services.rhea.routeActions(quote.hops, amount, minOut),
    });
    const via = quote.hops.length > 1 ? " via wNEAR" : "";
    const description = `Swap ${fmt(from, amount)} for ${to.symbol} on Rhea${via}: quoted ${fmt(to, quote.out)}, at least ${fmt(to, minOut)} (${slippage / 100}% slippage)`;
    return makeProposal(ctx, dao, description, kind);
  },
};

/** The liquid staking provider named in `raw` (default: the first configured), or a UserError. */
function providerArg(raw) {
  try {
    return services.lst.provider(raw?.toLowerCase());
  } catch (err) {
    const names = services.lst.providers().map(([key]) => key);
    throw new UserError(names.length ? `${err.message}. Choose ${names.join(" or ")}.` : "Liquid staking isn't set up on this network.");
  }
}

const liquidstake = {
  section: "Treasury",
  needsDao: true,
  usage: "<amount> [linear|metapool|nearx]",
  description: "Propose staking treasury NEAR with a liquid staking protocol",
  options: [
    { name: "amount", description: "NEAR to stake", required: true },
    { name: "provider", description: "linear, metapool or nearx (default linear)", required: false },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("liquidstake")} <amount> [linear|metapool|nearx]`;
    const dao = requireDao(ctx);
    const amount = parseAmount(ctx.args[0], NEAR_DECIMALS, usage);
    const lst = providerArg(ctx.args[1]);
    const held = await services.core.availableNear(dao.daoId);
    if (held < amount) throw new UserError(`The treasury has ${formatNear(held)} NEAR available, less than ${formatNear(amount)}.`);
    return makeProposal(ctx, dao, `Stake ${formatNear(amount)} NEAR with ${lst.label}`, kinds.liquidStake(lst.id, amount));
  },
};

const liquidunstake = {
  section: "Treasury",
  needsDao: true,
  usage: "<amount> [linear|metapool|nearx]",
  description: "Propose unstaking treasury NEAR from liquid staking (about 2-3 days)",
  options: [
    { name: "amount", description: "NEAR to unstake", required: true },
    { name: "provider", description: "linear, metapool or nearx (default linear)", required: false },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("liquidunstake")} <amount> [linear|metapool|nearx]`;
    const dao = requireDao(ctx);
    const amount = parseAmount(ctx.args[0], NEAR_DECIMALS, usage);
    const lst = providerArg(ctx.args[1]);
    const { staked } = await services.lst.position(lst.id, dao.daoId);
    if (staked < amount) throw new UserError(`The treasury has ${formatNear(staked)} NEAR staked with ${lst.label}.`);
    const description = `Unstake ${formatNear(amount)} NEAR from ${lst.label}; withdraw it with ${ctx.cmd("liquidwithdraw")} once ready`;
    return makeProposal(ctx, dao, description, kinds.liquidUnstake(lst.id, amount));
  },
};

const liquidwithdraw = {
  section: "Treasury",
  needsDao: true,
  usage: "[linear|metapool|nearx]",
  description: "Propose withdrawing NEAR that finished unstaking back to the treasury",
  options: [{ name: "provider", description: "linear, metapool or nearx (default linear)", required: false }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const lst = providerArg(ctx.args[0]);
    const { unstaked, available } = await services.lst.position(lst.id, dao.daoId);
    if (unstaked === 0n) throw new UserError(`Nothing is unstaking from ${lst.label}.`);
    if (!available) throw new UserError(`${formatNear(unstaked)} NEAR is still unstaking from ${lst.label}; try again in a day or two.`);
    return makeProposal(ctx, dao, `Withdraw ${formatNear(unstaked)} unstaked NEAR from ${lst.label}`, kinds.liquidWithdraw(lst.id, lst.withdrawMethod));
  },
};

export const TREASURY_COMMANDS = { swap, liquidstake, liquidunstake, liquidwithdraw };
