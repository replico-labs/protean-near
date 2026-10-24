import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { fromUnits } from "../../near/amounts.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount, formatTime, recipientAccount, copyableAccount } from "../helpers.js";
import { latestProposals } from "../proposals.js";
import { makeProposal } from "./proposing.js";
import * as kinds from "../../near/kinds.js";

/**
 * Hyperliquid perps for the DAO's own EVM address (Chain Signatures).
 * Voting on every order would be too slow, so the DAO appoints a trading
 * agent: an address that can place and cancel orders for its account but
 * can't withdraw. Appointing, revoking and moving money out each take a
 * proposal. Fund the account through NEAR Intents:
 * /paychain <amount> USDC@hypercore dao.
 */

const DEFAULT_AGENT = "protean";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

async function daoAddress(dao) {
  try {
    return await services.chainsig.evmAddress(dao.daoId);
  } catch (err) {
    throw new UserError(`Chain Signatures isn't available: ${err.message}`);
  }
}

/**
 * Proposes Hyperliquid `actions` for the DAO's key to sign. The actions
 * carry a nonce, which Hyperliquid accepts for about three days, so the
 * proposal must execute by then; a late one is refused, and nothing moves.
 */
async function proposeHyperliquid(ctx, dao, description, actions, validUntil) {
  const from = await daoAddress(dao);
  await userAccount(ctx);
  const kind = services.chainsig.signKind(actions.map((a) => services.hyperliquid.digest(a)));
  const text = services.evm.withTxs(`${description} (Hyperliquid, the DAO's account ${from}). Execute by ${formatTime(BigInt(validUntil.getTime()) * 1_000_000n)}, or Hyperliquid will refuse it`, {
    hyperliquid: true,
    from,
    actions,
  });
  return makeProposal(ctx, dao, text, kind);
}

const hyperliquid = {
  section: "Treasury",
  needsDao: true,
  usage: "",
  description: "The DAO's Hyperliquid account: value, withdrawable USDC and open positions",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const address = await daoAddress(dao);
    const account = await services.hyperliquid.account(address).catch(() => null);
    if (!account) return reply(`Couldn't read Hyperliquid for \`${address}\` right now.`);
    const positions = account.positions.length ? account.positions.map((p) => `• ${p.coin}: ${p.size} (≈ $${p.value})`).join("\n") : "No open positions.";
    const rules = await currentRules(dao).catch(() => null);
    const agent = await services.hlAgents.findAgentAddress(dao.daoId).catch(() => null);
    // Agents other than the bot's (approved before only the bot could be one) trade outside the DAO's limits.
    const others = (await services.hyperliquid.agents(address).catch(() => [])).filter((a) => a.address.toLowerCase() !== agent?.toLowerCase());
    const warnings = others.map((a) => `⚠️ Another agent can trade this account outside the DAO's limits: \`${a.address}\` ("${a.name}"). Remove it: \`${ctx.cmd("hlrevoke")} ${a.name}\``);
    return reply(
      [
        `*Hyperliquid account* \`${address}\``,
        `Perps (trading): $${account.accountValue} · Withdrawable: ${account.withdrawable} USDC`,
        positions,
        Number(account.spotUsdc) > 0 ? `Spot: ${account.spotUsdc} USDC, not usable for trading until moved: \`${ctx.cmd("hlmove")} all perps\`` : null,
        ...(rules ? ["", "*Trading from the chat*", ...describeRules(rules, ctx.cmd)] : []),
        agent ? `The bot's agent: \`${agent}\` (approved with \`${ctx.cmd("hlagent")}\`)` : `Let traders trade from the chat: \`${ctx.cmd("hlagent")}\``,
        ...warnings,
        `Fund it: \`${ctx.cmd("paychain")} <amount> USDC@hypercore dao <description>\``,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    );
  },
};

/**
 * Only the bot's own key for the DAO can become its agent. An agent can't
 * withdraw, but one held by a person or another program would trade
 * outside the bot, past the traders and limits the DAO voted for, and
 * could empty the account through bad trades.
 */
const hlagent = {
  section: "Treasury",
  needsDao: true,
  usage: "",
  description: "Propose the bot as the DAO's Hyperliquid trading agent, so the traders the DAO names trade from the chat within its limits; it can trade, never withdraw",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const [raw] = ctx.args;
    if (raw !== undefined && String(raw).toLowerCase() !== "bot") {
      throw new UserError(
        `Only the bot can be the DAO's Hyperliquid agent: \`${ctx.cmd("hlagent")}\`. An agent held by anyone else would trade outside the traders and limits the DAO votes for (\`${ctx.cmd("hltraders")}\`, \`${ctx.cmd("hllimits")}\`).`
      );
    }
    // A key the bot generates and keeps for this DAO (KMS-encrypted), used only for the chat's trades.
    const agent = (await services.hlAgents.getOrCreateAgentKey(dao.daoId)).address;
    const { nonce, validUntil } = services.hyperliquid.nonceForProposal();
    const action = services.hyperliquid.approveAgent(agent, DEFAULT_AGENT, nonce);
    return proposeHyperliquid(
      ctx,
      dao,
      `Appoint the bot's agent ${agent} as the DAO's Hyperliquid trading agent "${DEFAULT_AGENT}", so the traders the DAO names can trade from the chat within its limits (\`${ctx.cmd("hltraders")}\`, \`${ctx.cmd("hllimits")}\`): it can place and cancel orders, but not withdraw`,
      [action],
      validUntil
    );
  },
};

const hlrevoke = {
  section: "Treasury",
  needsDao: true,
  usage: "[name]",
  description: "Propose revoking the DAO's Hyperliquid trading agent",
  options: [{ name: "name", description: `Agent name (default ${DEFAULT_AGENT})`, required: false }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const name = ctx.args[0] ?? DEFAULT_AGENT;
    // Hyperliquid replaces an agent by approving another under the same name; this one's key is thrown away.
    const nobody = privateKeyToAccount(generatePrivateKey()).address;
    const { nonce, validUntil } = services.hyperliquid.nonceForProposal();
    const action = services.hyperliquid.approveAgent(nobody, name, nonce);
    return proposeHyperliquid(ctx, dao, `Revoke the DAO's Hyperliquid trading agent "${name}" (replaced by ${nobody}, whose key nobody holds)`, [action], validUntil);
  },
};

const hlsend = {
  section: "Treasury",
  needsDao: true,
  usage: "<amount> <address>",
  description: "Propose sending USDC from the DAO's Hyperliquid account to an address on Hyperliquid",
  options: [
    { name: "amount", description: "USDC", required: true },
    { name: "address", description: "Recipient's address on Hyperliquid", required: true },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("hlsend")} <amount> <address>`;
    const dao = requireDao(ctx);
    const [rawAmount, destination] = ctx.args;
    // The amount is signed as text: one canonical form ("1.5", not "1.50").
    const amount = fromUnits(parseAmount(rawAmount, 6, usage), 6, 6);
    if (!EVM_ADDRESS.test(destination ?? "")) throw new UserError(`\`${destination ?? ""}\` isn't an address. Usage: \`${usage}\``);
    const account = await services.hyperliquid.account(await daoAddress(dao)).catch(() => null);
    if (account && Number(account.withdrawable) < Number(amount)) throw new UserError(`The DAO's Hyperliquid account has ${account.withdrawable} USDC withdrawable.`);
    const { nonce, validUntil } = services.hyperliquid.nonceForProposal();
    const action = services.hyperliquid.usdSend(destination, amount, nonce);
    return proposeHyperliquid(ctx, dao, `Send ${amount} USDC from the DAO's Hyperliquid account to ${destination}`, [action], validUntil);
  },
};

const hlmove = {
  section: "Treasury",
  needsDao: true,
  usage: "<amount|all> perps|spot",
  description: "Propose moving the DAO's Hyperliquid USDC between its spot balance and perps (trading)",
  options: [
    { name: "amount", description: "USDC, or all", required: true },
    { name: "to", description: "perps (default) or spot", required: false, choices: ["perps", "spot"] },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("hlmove")} <amount|all> perps|spot`;
    const dao = requireDao(ctx);
    const [rawAmount, rawTo = "perps"] = ctx.args;
    const to = String(rawTo).toLowerCase();
    if (to !== "perps" && to !== "spot") throw new UserError(`Usage: \`${usage}\``);
    const toPerp = to === "perps";
    const account = await services.hyperliquid.account(await daoAddress(dao)).catch(() => null);
    const available = account ? (toPerp ? account.spotUsdc : account.withdrawable) : null;
    let amount;
    if (String(rawAmount).toLowerCase() === "all") {
      if (available === null) throw new UserError("Couldn't read the DAO's Hyperliquid account right now; give an amount.");
      if (!(Number(available) > 0)) throw new UserError(`The DAO has no USDC ${toPerp ? "in spot" : "free in perps"} to move.`);
      // Hyperliquid takes amounts as decimal strings; keep what it reported, at most 6 decimals.
      amount = fromUnits(parseAmount(available, 6, usage), 6, 6);
    } else {
      amount = fromUnits(parseAmount(rawAmount, 6, usage), 6, 6);
      if (available !== null && Number(available) < Number(amount)) throw new UserError(`The DAO has ${available} USDC ${toPerp ? "in spot" : "free in perps"}.`);
    }
    const { nonce, validUntil } = services.hyperliquid.nonceForProposal();
    const action = services.hyperliquid.usdClassTransfer(amount, toPerp, nonce);
    return proposeHyperliquid(ctx, dao, `Move ${amount} USDC in the DAO's Hyperliquid account from ${toPerp ? "spot to perps, for trading" : "perps to spot"}`, [action], validUntil);
  },
};

// --- Trading from the chat, through the bot's agent ---
//
// The DAO's trading rules are a proposal: who may trade (by NEAR account),
// the largest position per market in USD, the highest leverage, and which
// markets. A rules proposal carries the whole new set after a marker in its
// description; the rules in force are those of the latest such proposal the
// core executed, so they survive model switches and only a vote changes
// them. Until all three limits are set, nobody trades.

const RULES = "\n\n---\nhyperliquid-rules:";
const NO_RULES = { traders: [], maxPositionUsd: null, maxLeverage: null, markets: [] };
const OPEN = new Set(["Pending", "Active", "ChallengeWindow", "Succeeded", "Queued", "Positions", "InProgress"]);

/** The rules a proposal's description carries, or null. */
export function rulesIn(description) {
  const at = String(description ?? "").indexOf(RULES);
  if (at < 0) return null;
  try {
    return { ...NO_RULES, ...JSON.parse(description.slice(at + RULES.length)) };
  } catch {
    return null;
  }
}

/** The DAO's trading rules in force: from the latest rules proposal its core executed. */
export async function currentRules(dao) {
  const last = await services.core.getLastProposalId(dao.daoId);
  for (let to = last; to > 0; to -= 50) {
    const from = Math.max(0, to - 50);
    const page = await services.core.getCoreProposals(dao.daoId, from, to - from);
    for (const p of [...page].reverse()) {
      const rules = p.status === "Approved" && rulesIn(p.description);
      if (rules) return rules;
    }
  }
  return { ...NO_RULES };
}

const usd = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function describeRules(rules, cmd) {
  const missing = [!rules.traders.length && "traders", !rules.maxPositionUsd && "a position limit", !rules.maxLeverage && "a leverage limit", !rules.markets.length && "markets"].filter(Boolean);
  return [
    `Traders: ${rules.traders.length ? rules.traders.map((t) => `\`${t}\``).join(", ") : "none"}`,
    `Limits: positions up to ${rules.maxPositionUsd ? usd(rules.maxPositionUsd) : "—"} per market · leverage up to ${rules.maxLeverage ? `${rules.maxLeverage}×` : "—"} · markets ${rules.markets.length ? rules.markets.join(", ") : "—"}`,
    missing.length ? `Trading from the chat needs ${missing.join(", ")} (\`${cmd("hltraders")}\`, \`${cmd("hllimits")}\`).` : null,
  ].filter(Boolean);
}

/** Proposes `rules` as the DAO's new trading rules; one rules proposal open at a time, so none undoes another. */
async function proposeRules(ctx, dao, change, rules) {
  const { items } = await latestProposals(dao, 20);
  if (items.some(([, state, text]) => OPEN.has(state) && rulesIn(text))) {
    throw new UserError("Another proposal changing the Hyperliquid trading rules is still open. Let it finish first.");
  }
  return makeProposal(ctx, dao, `Hyperliquid trading rules: ${change}${RULES}${JSON.stringify(rules)}`, kinds.signal());
}

const hltraders = {
  section: "Treasury",
  needsDao: true,
  usage: "add|remove <account>",
  description: "Propose adding or removing a trader who may trade the DAO's Hyperliquid account from the chat",
  options: [
    { name: "action", description: "add or remove", required: true, choices: ["add", "remove"] },
    { name: "account", description: "Their NEAR account, me, or @mention them (or reply to them)", required: false },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("hltraders")} add|remove <account>`;
    const dao = requireDao(ctx);
    const action = String(ctx.args[0] ?? "").toLowerCase();
    if (action !== "add" && action !== "remove") throw new UserError(`Usage: \`${usage}\``);
    if (ctx.args[1] === undefined && !ctx.replyTo) throw new UserError(`Name the trader, or reply to their message. Usage: \`${usage}\``);
    const trader = await recipientAccount(ctx, ctx.args[1], usage);
    const rules = await currentRules(dao);
    const has = rules.traders.includes(trader);
    if (action === "add" && has) throw new UserError(`\`${trader}\` is already a trader.`);
    if (action === "remove" && !has) throw new UserError(`\`${trader}\` isn't a trader.`);
    const traders = action === "add" ? [...rules.traders, trader] : rules.traders.filter((t) => t !== trader);
    return proposeRules(ctx, dao, `${action === "add" ? "add" : "remove"} ${trader} as a trader`, { ...rules, traders });
  },
};

const hllimits = {
  section: "Treasury",
  needsDao: true,
  usage: "size <usd> | leverage <n> | markets <COIN,COIN...>",
  description: "Propose the limits for trading the DAO's Hyperliquid account from the chat",
  options: [
    { name: "limit", description: "size, leverage or markets", required: true, choices: ["size", "leverage", "markets"] },
    { name: "value", description: "USD per market, the highest leverage, or coins (BTC,ETH,SOL)", required: true, rest: true },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("hllimits")} size <usd> | leverage <n> | markets <COIN,COIN...>`;
    const dao = requireDao(ctx);
    const [limit, ...rest] = ctx.args;
    const value = rest.join(" ");
    const rules = await currentRules(dao);
    switch (String(limit ?? "").toLowerCase()) {
      case "size": {
        const n = Number(value.replace(/[$,]/g, ""));
        if (!(n > 0)) throw new UserError(`The largest position per market, in USD. Usage: \`${usage}\``);
        return proposeRules(ctx, dao, `positions up to ${usd(n)} per market`, { ...rules, maxPositionUsd: n });
      }
      case "leverage": {
        const n = Number(value.replace(/x$/i, ""));
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new UserError(`A whole number from 1 to 50. Usage: \`${usage}\``);
        return proposeRules(ctx, dao, `leverage up to ${n}×`, { ...rules, maxLeverage: n });
      }
      case "markets": {
        const coins = [...new Set(value.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase()))];
        if (!coins.length) throw new UserError(`Usage: \`${usage}\``);
        const known = await services.hyperliquid.markets().catch(() => null);
        const unknown = known ? coins.filter((c) => !known[c]) : [];
        if (unknown.length) throw new UserError(`Hyperliquid has no perp market for ${unknown.join(", ")}.`);
        return proposeRules(ctx, dao, `trade only ${coins.join(", ")}`, { ...rules, markets: coins });
      }
      default:
        throw new UserError(`Usage: \`${usage}\``);
    }
  },
};

/** Who's trading and what for: the trader, the DAO's address, its rules, the bot's agent key, and the account. */
async function tradingContext(ctx, dao) {
  const [account, rules, address] = await Promise.all([userAccount(ctx), currentRules(dao), daoAddress(dao)]);
  if (!rules.traders.includes(account.accountId)) {
    throw new UserError(`Only the DAO's traders trade from the chat${rules.traders.length ? "" : ", and it has none yet"}. Propose one with \`${ctx.cmd("hltraders")} add <account>\`.`);
  }
  if (!rules.maxPositionUsd || !rules.maxLeverage || !rules.markets.length) throw new UserError(describeRules(rules, ctx.cmd).at(-1));
  const agent = await services.hlAgents.findAgentAddress(dao.daoId);
  const approved = agent && (await services.hyperliquid.agents(address)).some((a) => a.address.toLowerCase() === agent.toLowerCase());
  if (!approved) throw new UserError(`The DAO hasn't approved the bot as its Hyperliquid agent yet: \`${ctx.cmd("hlagent")}\`, then vote and execute.`);
  const [markets, mids, state] = await Promise.all([services.hyperliquid.markets(), services.hyperliquid.mids(), services.hyperliquid.account(address)]);
  return { account, rules, address, agent, markets, mids, state };
}

/** Sends `actions` in order with the bot's agent key for the DAO; returns the last response. */
async function trade(dao, actions) {
  const key = await (await services.hlAgents.getOrCreateAgentKey(dao.daoId)).privateKey();
  let response;
  for (const action of actions) response = await services.hyperliquid.sendL1(key, action);
  return response;
}

function openPosition(side) {
  return {
    section: "Treasury",
    needsDao: true,
    usage: "<coin> <usd> [leverage]",
    description: `${side === "long" ? "Buy" : "Sell"} a ${side} position for the DAO on Hyperliquid (traders the DAO named, within its limits)`,
    options: [
      { name: "coin", description: "The market, e.g. ETH", required: true },
      { name: "usd", description: "Position size in USD", required: true },
      { name: "leverage", description: "e.g. 3x (default 1x)", required: false },
    ],
    async run(ctx) {
      const usage = `${ctx.cmd(side)} <coin> <usd> [leverage]`;
      const dao = requireDao(ctx);
      const [rawCoin, rawUsd, rawLeverage = "1"] = ctx.args;
      const coin = String(rawCoin ?? "").toUpperCase();
      const amount = Number(String(rawUsd ?? "").replace(/[$,]/g, ""));
      const leverage = Number(String(rawLeverage).replace(/x$/i, ""));
      if (!coin || !(amount > 0) || !Number.isInteger(leverage) || leverage < 1) throw new UserError(`Usage: \`${usage}\`, e.g. \`${ctx.cmd(side)} ETH 500 3x\``);
      const t = await tradingContext(ctx, dao);
      if (!t.rules.markets.includes(coin)) throw new UserError(`The DAO trades only ${t.rules.markets.join(", ")}.`);
      const market = t.markets[coin];
      const mid = t.mids[market?.coin];
      if (!market || !mid) throw new UserError(`Hyperliquid has no ${coin} market right now.`);
      if (leverage > t.rules.maxLeverage || leverage > market.maxLeverage) throw new UserError(`Leverage is limited to ${Math.min(t.rules.maxLeverage, market.maxLeverage)}× here.`);
      const isBuy = side === "long";
      const size = amount / mid;
      const held = Number(t.state.positions.find((p) => p.coin === market.coin)?.size ?? 0);
      const after = Math.abs(held + (isBuy ? size : -size)) * mid;
      if (after > t.rules.maxPositionUsd) {
        const room = Math.max(0, t.rules.maxPositionUsd - Math.abs(held) * mid);
        throw new UserError(`That would make the DAO's ${coin} position ${usd(after)}; the DAO allows ${usd(t.rules.maxPositionUsd)} per market${room ? ` (room for about ${usd(room)} more)` : ""}.`);
      }
      const order = services.hyperliquid.marketOrder(market, isBuy, size, mid);
      if (Number(order.orders[0].s) === 0) throw new UserError(`${usd(amount)} is too small for ${coin}.`);
      const result = services.hyperliquid.orderResult(await trade(dao, [services.hyperliquid.updateLeverage(market.asset, leverage), order]));
      if (result.error) return reply(`⚠️ Hyperliquid didn't fill it: ${result.error}`);
      return reply(`${isBuy ? "📈" : "📉"} ${side === "long" ? "Bought" : "Sold"} ${result.filled} ${coin} at $${result.avgPx} (≈ ${usd(Number(result.filled) * Number(result.avgPx))}), ${leverage}× leverage, for the DAO's Hyperliquid account.`);
    },
  };
}

const close = {
  section: "Treasury",
  needsDao: true,
  usage: "<coin>",
  description: "Close the DAO's Hyperliquid position in a market (its traders)",
  options: [{ name: "coin", description: "The market, e.g. ETH", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const coin = String(ctx.args[0] ?? "").toUpperCase();
    if (!coin) throw new UserError(`Usage: \`${ctx.cmd("close")} <coin>\``);
    const t = await tradingContext(ctx, dao);
    const market = t.markets[coin];
    const held = Number(t.state.positions.find((p) => p.coin === market?.coin)?.size ?? 0);
    if (!market || !held) throw new UserError(`The DAO has no ${coin} position.`);
    // Closing is always allowed for a trader, whatever the limits: it only reduces the position.
    const order = services.hyperliquid.marketOrder(market, held < 0, Math.abs(held), t.mids[market.coin], { reduceOnly: true });
    const result = services.hyperliquid.orderResult(await trade(dao, [order]));
    if (result.error) return reply(`⚠️ Hyperliquid didn't fill it: ${result.error}`);
    return reply(`✅ Closed ${result.filled} ${coin} at $${result.avgPx} for the DAO's Hyperliquid account.`);
  },
};

export const HYPERLIQUID_COMMANDS = { hyperliquid, hlagent, hlrevoke, hlsend, hlmove, hltraders, hllimits, long: openPosition("long"), short: openPosition("short"), close };
