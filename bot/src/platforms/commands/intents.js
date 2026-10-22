import { NEAR_DECIMALS, fromUnits } from "../../near/amounts.js";
import * as kinds from "../../near/kinds.js";
import { executionHorizonNs } from "../../near/models.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount, parseId, tokenInfo, formatTime, nowNs } from "../helpers.js";
import { makeProposal } from "./proposing.js";
import { loadProposal } from "../proposals.js";

/**
 * NEAR Intents, by proposal: buy any token it lists, or pay an exact amount
 * to an address on another chain, from the treasury on NEAR.
 *
 * The bot gets a live 1Click quote and proposes depositing into it. A quote
 * has a deadline after which depositing can lose the funds, so the bot only
 * proposes when the quote outlives the last moment the proposal could
 * execute (voting, timelock and execution window). If the price moves past
 * the slippage, the deposit is refunded to the DAO's NEAR Intents account.
 */

const DEFAULT_SLIPPAGE_BPS = 100;
/** Chains where an address is an EVM address, so the DAO has one there (Chain Signatures). */
const EVM_CHAINS = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "scroll", "monad", "xlayer", "plasma", "hypercore"]);
const HOUR_NS = 3_600_000_000_000n;

/** An amount of `asset` at full precision (BTC needs its 8 decimals), with its chain unless it's NEAR. */
const fmtAsset = (asset, units) => `${fromUnits(BigInt(units), asset.decimals, asset.decimals)} ${asset.symbol}${asset.blockchain === "near" ? "" : ` on ${asset.blockchain}`}`;

/** How long a proposal made now may still execute in this chat's DAO, or a UserError if its model has no bound. */
async function horizonNs(dao) {
  if (dao.model === "board") return executionHorizonNs("board", null, BigInt((await services.core.getPolicy(dao.daoId)).proposal_period));
  const { name, settings } = services.orbit.modelOf(await services.orbit.getModel(dao.orbitId));
  const horizon = executionHorizonNs(name, settings);
  if (horizon === null) throw new UserError(`NEAR Intents quotes expire, and a ${name} proposal has no fixed end, so it can't fund one safely.`);
  return horizon;
}

/** A treasury token on NEAR that 1Click trades: { id ("NEAR" or account), asset }; or a UserError. */
async function sourceArg(raw, daoToken, usage) {
  const id = services.tokens.resolve(raw, daoToken);
  if (!id) throw new UserError(`\`${raw ?? ""}\` isn't a token the treasury holds on NEAR. Usage: \`${usage}\``);
  const asset = await services.intents.nearAsset(id, services.venues.wrapNear);
  if (!asset) throw new UserError(`NEAR Intents doesn't trade ${raw}.`);
  // NEAR is paid as wrapped NEAR, but it's NEAR the treasury spends.
  return { id, asset: id === "NEAR" ? { ...asset, symbol: "NEAR" } : asset };
}

/** The treasury's spendable balance of `id` ("NEAR" or a token account). */
const treasuryHas = (dao, id) => (id === "NEAR" ? services.core.availableNear(dao.daoId) : services.staking.tokenBalance(id, dao.daoId));

/** "1" or "0.5%" as basis points; default 1%. */
function slippageArg(raw, usage) {
  if (raw === undefined) return DEFAULT_SLIPPAGE_BPS;
  const match = /^(\d+(?:\.\d{1,2})?)%?$/.exec(raw);
  const bps = match ? Math.round(Number(match[1]) * 100) : NaN;
  if (!(bps >= 1 && bps <= 5_000)) throw new UserError(`Slippage is a percentage from 0.01 to 50. Usage: \`${usage}\``);
  return bps;
}

/**
 * Gets a quote that outlives the proposal, checks the treasury covers it,
 * registers the DAO with the tokens it touches, and proposes funding it.
 */
async function proposeQuote(ctx, dao, { source, request, describe }) {
  const horizon = await horizonNs(dao);
  const mustLast = nowNs() + horizon;
  const deadline = new Date(Number((mustLast + HOUR_NS) / 1_000_000n));
  let quote;
  try {
    quote = await services.intents.quote({ dao: dao.daoId, ...request, deadline });
  } catch (err) {
    throw new UserError(`NEAR Intents couldn't quote that: ${err.message.replace(/^NEAR Intents: /, "")}`);
  }
  if (!quote?.depositAddress) throw new UserError("NEAR Intents has no quote for that right now.");
  const expires = BigInt(Date.parse(quote.deadline ?? "")) * 1_000_000n;
  if (!(expires >= mustLast)) {
    throw new UserError(`The quote expires ${formatTime(expires)}, before this proposal could still execute (${formatTime(mustLast)}). Shorten the DAO's execution window or try again.`);
  }
  const amountIn = BigInt(quote.amountIn);
  const held = await treasuryHas(dao, source.id);
  if (held < amountIn) throw new UserError(`It needs ${fmtAsset(source.asset, amountIn)}; the treasury has ${fmtAsset(source.asset, held)}.`);
  await userAccount(ctx);
  await services.intents.prepareDao(dao.daoId, source.id, request.to);
  const kind = kinds.intentsDeposit({ intents: services.intents.intentsId(), wrapNear: services.venues.wrapNear, token: source.id, amount: amountIn, depositAddress: quote.depositAddress });
  const description = `${describe(quote)} via NEAR Intents. Quote ${quote.correlationId ?? ""}, deposit by ${formatTime(expires)}; refunds go to the DAO's NEAR Intents account`;
  return makeProposal(ctx, dao, description, kind);
}

const buy = {
  section: "Treasury",
  needsDao: true,
  usage: "<amount> <from> <to>[@chain] [slippage%]",
  description: "Propose buying any token through NEAR Intents (BTC, ETH, SOL, USDC@base...)",
  options: [
    { name: "amount", description: "How much to spend", required: true },
    { name: "from", description: "What the treasury pays with on NEAR: NEAR, USDC, the DAO's token...", required: true },
    { name: "to", description: "What to buy, e.g. BTC, ETH or USDC@base", required: true },
    { name: "slippage", description: "Most the price may move, in % (default 1)", required: false },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("buy")} <amount> <from> <to>[@chain] [slippage%]`;
    const dao = requireDao(ctx);
    const [rawAmount, rawFrom, rawTo, rawSlippage] = ctx.args;
    const source = await sourceArg(rawFrom, await tokenInfo(dao), usage);
    const to = await services.intents.findAsset(rawTo).catch((err) => {
      throw new UserError(err.message);
    });
    if (!to) throw new UserError(`NEAR Intents doesn't list \`${rawTo ?? ""}\`. Usage: \`${usage}\``);
    const amount = parseAmount(rawAmount, source.asset.decimals, usage);
    // Tokens on NEAR come to the treasury; anything else stays in the DAO's NEAR Intents account.
    const onNear = to.blockchain === "near";
    return proposeQuote(ctx, dao, {
      source,
      request: { from: source.asset, to, amount, recipient: dao.daoId, recipientType: onNear ? "DESTINATION_CHAIN" : "INTENTS", slippageBps: slippageArg(rawSlippage, usage) },
      describe: (q) => `Buy at least ${fmtAsset(to, q.minAmountOut)} (quoted ${fmtAsset(to, q.amountOut)}) with ${fmtAsset(source.asset, q.amountIn)}${onNear ? "" : ", held in the DAO's NEAR Intents account"}`,
    });
  },
};

const paychain = {
  section: "Treasury",
  needsDao: true,
  usage: "<amount> <token>@<chain> <address> <description>",
  description: "Propose paying an exact amount to an address on another chain, through NEAR Intents",
  options: [
    { name: "amount", description: "What the recipient gets", required: true },
    { name: "token", description: "Token and chain, e.g. USDC@sol, ETH@base, BTC", required: true },
    { name: "address", description: "The recipient's address on that chain", required: true },
    { name: "description", description: "What it's for", required: true },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("paychain")} <amount> <token>@<chain> <address> <description>`;
    const dao = requireDao(ctx);
    const [rawAmount, rawTo, address, ...words] = ctx.args;
    const to = await services.intents.findAsset(rawTo).catch((err) => {
      throw new UserError(err.message);
    });
    if (!to) throw new UserError(`NEAR Intents doesn't list \`${rawTo ?? ""}\`. Usage: \`${usage}\``);
    if (!address) throw new UserError(`Add the recipient's address. Usage: \`${usage}\``);
    // "dao": the DAO's own address on that chain, from Chain Signatures (EVM chains).
    let recipient = address;
    if (address.toLowerCase() === "dao") {
      if (!EVM_CHAINS.has(to.blockchain)) throw new UserError(`The DAO has its own address on EVM chains only, not ${to.blockchain}.`);
      recipient = await services.chainsig.evmAddress(dao.daoId).catch((err) => {
        throw new UserError(`Chain Signatures isn't available: ${err.message}`);
      });
    }
    const amount = parseAmount(rawAmount, to.decimals, usage);
    // Pay with the same token if the treasury holds it on NEAR, otherwise with NEAR.
    const daoToken = await tokenInfo(dao);
    const same = services.tokens.resolve(to.symbol, daoToken);
    const candidates = same && same !== "NEAR" ? [same, "NEAR"] : ["NEAR"];
    let source = null;
    for (const id of candidates) {
      const asset = await services.intents.nearAsset(id, services.venues.wrapNear);
      if (asset && (await treasuryHas(dao, id)) > 0n) {
        source = { id, asset: id === "NEAR" ? { ...asset, symbol: "NEAR" } : asset };
        break;
      }
    }
    if (!source) throw new UserError("The treasury has nothing NEAR Intents can pay with.");
    return proposeQuote(ctx, dao, {
      source,
      request: { from: source.asset, to, amount, exactOutput: true, recipient, recipientType: "DESTINATION_CHAIN", slippageBps: DEFAULT_SLIPPAGE_BPS },
      describe: (q) => `${words.join(" ") || "Payment"}: pay ${fmtAsset(to, amount)} to ${recipient === address ? address : `the DAO's own address ${recipient}`}, using up to ${fmtAsset(source.asset, q.amountIn)} (any excess is refunded)`,
    });
  },
};

const intentsstatus = {
  section: "Treasury",
  needsDao: true,
  usage: "<id>",
  description: "Where a NEAR Intents proposal's swap or payment is",
  options: [{ name: "id", description: "Proposal number", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const id = parseId(ctx.args[0], `${ctx.cmd("intentsstatus")} <id>`);
    const p = await loadProposal(dao, id, await tokenInfo(dao));
    const deposit = p?.kind?.FunctionCall && kinds.describeIntentsDeposit(p.kind.FunctionCall);
    if (!deposit) throw new UserError(`#${id} isn't a NEAR Intents proposal.`);
    const s = await services.intents.status(deposit.depositAddress).catch(() => null);
    const state = s?.status ?? "not funded yet";
    const words = {
      PENDING_DEPOSIT: "waiting for the deposit (the proposal hasn't executed)",
      KNOWN_DEPOSIT_TX: "deposit seen",
      PROCESSING: "being filled",
      SUCCESS: "done ✅",
      REFUNDED: "refunded to the DAO's NEAR Intents account",
      INCOMPLETE_DEPOSIT: "deposit too small; it will be refunded",
      FAILED: "failed",
    };
    return reply(`*#${id}* on NEAR Intents: ${words[state] ?? state}`);
  },
};

const intentswithdraw = {
  section: "Treasury",
  needsDao: true,
  usage: "<amount> <token>",
  description: "Propose moving tokens from the DAO's NEAR Intents account (e.g. refunds) back to the treasury",
  options: [
    { name: "amount", description: "How much", required: true },
    { name: "token", description: "NEAR, USDC, the DAO's token or a token account", required: true },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("intentswithdraw")} <amount> <token>`;
    const dao = requireDao(ctx);
    const id = services.tokens.resolve(ctx.args[1], await tokenInfo(dao));
    if (!id) throw new UserError(`Usage: \`${usage}\``);
    const token = id === "NEAR" ? services.venues.wrapNear : id;
    const meta = id === "NEAR" ? { symbol: "wNEAR", decimals: NEAR_DECIMALS } : await services.tokens.info(token);
    const amount = parseAmount(ctx.args[0], meta.decimals, usage);
    const held = BigInt(await services.intents.balanceOf(dao.daoId, `nep141:${token}`));
    if (held < amount) throw new UserError(`The DAO's NEAR Intents account has ${fromUnits(held, meta.decimals)} ${meta.symbol}.`);
    await services.intents.prepareDao(dao.daoId, token, null);
    const kind = kinds.intentsWithdraw({ intents: services.intents.intentsId(), token, amount, receiver: dao.daoId });
    return makeProposal(ctx, dao, `Withdraw ${fromUnits(amount, meta.decimals)} ${meta.symbol} from the DAO's NEAR Intents account to the treasury`, kind);
  },
};

export const INTENTS_COMMANDS = { buy, paychain, intentsstatus, intentswithdraw };
