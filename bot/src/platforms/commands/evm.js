import { fromUnits } from "../../near/amounts.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount } from "../helpers.js";
import { latestProposals } from "../proposals.js";
import { makeProposal } from "./proposing.js";

/**
 * The DAO on EVM chains, through NEAR Chain Signatures: its own address,
 * controlled only by its proposals. A proposal carries the unsigned
 * transactions and asks the signing network to sign them; when it
 * executes, the bot sends them (relayEvm).
 */

const USDC_DECIMALS = 6;
const ETH_DECIMALS = 18;
const OPEN = new Set(["Pending", "Active", "ChallengeWindow", "Succeeded", "Queued", "Positions", "InProgress"]);
const fundingHint = (cmd) => `Fund it through NEAR Intents: \`${cmd("paychain")} 0.002 ETH@base dao gas for the DAO's Base address\``;

/** The DAO's EVM address, or a UserError if Chain Signatures isn't available here. */
async function daoAddress(dao) {
  try {
    return await services.chainsig.evmAddress(dao.daoId);
  } catch (err) {
    throw new UserError(`Chain Signatures isn't available: ${err.message}`);
  }
}

/** Proposes signing `calls` from the DAO's address on Base, after checking it can pay the gas. */
async function proposeEvm(ctx, dao, description, calls) {
  const chain = services.evm.base();
  const from = await daoAddress(dao);
  // Transactions are numbered (nonces) when proposed, so two pending at once would collide.
  const { items } = await latestProposals(dao, 20);
  if (items.some(([, state, text]) => OPEN.has(state) && services.evm.txsIn(text))) {
    throw new UserError("Another proposal with transactions for the DAO's EVM address is still open. Execute or cancel it first.");
  }
  const params = await services.evm.txParams(chain, from).catch((err) => {
    throw new UserError(`Couldn't reach ${chain.name}: ${err.message}`);
  });
  const txs = services.evm.unsignedTxs(chain, calls, params);
  // Gas at its most, plus any ETH the transactions send (supplying ETH to Aave).
  const needed = txs.reduce((sum, t) => sum + t.maxCost, 0n);
  const sends = calls.reduce((sum, c) => sum + (c.value ?? 0n), 0n);
  const { eth } = await services.evm.balances(chain, from, {});
  if (eth < needed) {
    const what = sends ? `${fromUnits(sends, ETH_DECIMALS, 6)} ETH plus up to ${fromUnits(needed - sends, ETH_DECIMALS, 6)} for gas` : `up to ${fromUnits(needed, ETH_DECIMALS, 6)} ETH for gas`;
    throw new UserError(`The DAO's ${chain.name} address \`${from}\` needs ${what}, and has ${fromUnits(eth, ETH_DECIMALS, 6)} ETH. ${fundingHint(ctx.cmd)}`);
  }
  await userAccount(ctx);
  const kind = services.chainsig.signKind(txs.map((t) => t.hash));
  const text = services.evm.withTxs(`${description} (on ${chain.name}, from the DAO's address ${from})`, { chain: chain.chainId, from, txs: txs.map((t) => t.serialized) });
  return makeProposal(ctx, dao, text, kind);
}

// A transaction sent before (by an earlier try) answers like this when sent again.
const ALREADY_SENT = /already known|nonce too low|known transaction/i;

/**
 * Remembers the NEAR transaction executing proposal `key` before waiting for
 * it, so its signatures can be read again if the bot misses them (the
 * signing network answers in 10-30 seconds, and an RPC may stop waiting).
 */
export function rememberExecution(ctx, key, txHash, sender) {
  const link = services.db.getChatDao(ctx.platform, ctx.chatId);
  if (link) services.db.setChatDao(ctx.platform, ctx.chatId, { ...link, relays: { ...link.relays, [key]: { txHash, sender } } });
}

/** Sends what an execution signed; forgets the execution once everything went through, or says how to retry. */
export async function relayExecution(ctx, key, retry, payload, outcome) {
  const { text, complete } = await relayEvm(payload, outcome);
  const link = services.db.getChatDao(ctx.platform, ctx.chatId);
  if (!complete) return `${text}\nThe DAO's signatures stay valid: \`${retry}\` tries sending again.`;
  if (link?.relays?.[key]) {
    const { [key]: _, ...rest } = link.relays;
    services.db.setChatDao(ctx.platform, ctx.chatId, { ...link, relays: rest });
  }
  return text;
}

/**
 * For a proposal that already executed: reads its execution again, by the
 * hash remembered when it ran, and sends what it signed. Null if the bot has
 * nothing left to send for it.
 */
export async function retryRelay(ctx, key, retry, payload) {
  const pending = services.db.getChatDao(ctx.platform, ctx.chatId)?.relays?.[key];
  if (!pending) return null;
  const outcome = await services.core.transactionOutcome(pending.txHash, pending.sender).catch((err) => {
    throw new UserError(`Couldn't read the execution (${pending.txHash}) yet: ${err.message}. Try again in a minute.`);
  });
  return relayExecution(ctx, key, retry, payload, outcome);
}

/**
 * After a proposal carrying EVM transactions executes: takes the signatures
 * from the execution's outcome, checks each was made by the DAO's address,
 * sends the transactions in order, and says what happened. `complete` is
 * false if anything wasn't sent.
 */
export async function relayEvm(payload, outcome) {
  if (payload.hyperliquid) return relayHyperliquid(payload, outcome);
  const chain = services.evm.base();
  const signatures = services.chainsig.signaturesFrom(outcome);
  if (signatures.length !== payload.txs.length) {
    return { text: `\n\n⚠️ Expected ${payload.txs.length} signature(s) for ${chain.name}, found ${signatures.length}. Nothing was sent.`, complete: false };
  }
  const lines = [];
  const unused = [...signatures];
  for (const [i, serialized] of payload.txs.entries()) {
    // The network may answer in any order: each transaction takes the signature that recovers to the DAO for it.
    let signed = null;
    for (const [j, signature] of unused.entries()) {
      signed = await services.evm.signedTx(serialized, signature, payload.from).catch(() => null);
      if (signed) {
        unused.splice(j, 1);
        break;
      }
    }
    if (!signed) {
      lines.push(`⚠️ No signature from the DAO's address matches transaction ${i + 1}; nothing more was sent.`);
      return { text: `\n\n${lines.join("\n")}`, complete: false };
    }
    try {
      lines.push(`✅ Sent on ${chain.name}: \`${await services.evm.broadcast(chain, signed)}\``);
    } catch (err) {
      if (ALREADY_SENT.test(err.message)) {
        lines.push(`✅ Transaction ${i + 1} was already sent on ${chain.name}.`);
        continue;
      }
      lines.push(`⚠️ Transaction ${i + 1} wasn't sent: ${err.message}`);
      return { text: `\n\n${lines.join("\n")}`, complete: false };
    }
  }
  return { text: `\n\n${lines.join("\n")}`, complete: true };
}

/** Hyperliquid actions: each takes the signature that recovers to the DAO for it, then goes to Hyperliquid's API. */
async function relayHyperliquid(payload, outcome) {
  const signatures = services.chainsig.signaturesFrom(outcome);
  const lines = [];
  const unused = [...signatures];
  for (const action of payload.actions) {
    let done = false;
    let lastError = null;
    for (const [j, signature] of unused.entries()) {
      try {
        await services.hyperliquid.submit(action, signature, payload.from);
        unused.splice(j, 1);
        const what = { approveAgent: () => `the agent ${action.agentAddress}`, usdClassTransfer: () => `moving ${action.amount} USDC to ${action.toPerp ? "perps (trading)" : "spot"}` }[action.type]?.() ?? `sending ${action.amount} USDC to ${action.destination}`;
        lines.push(`✅ Hyperliquid accepted ${what}`);
        done = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!done) {
      lines.push(`⚠️ Hyperliquid didn't take it: ${lastError?.message ?? "no signature from the DAO's address"}`);
      return { text: `\n\n${lines.join("\n")}`, complete: false };
    }
  }
  return { text: `\n\n${lines.join("\n")}`, complete: true };
}

const evm = {
  section: "Treasury",
  needsDao: true,
  usage: "",
  description: "The DAO's own address on EVM chains (Chain Signatures) and what it holds on Base",
  options: [],
  async run(ctx) {
    const dao = requireDao(ctx);
    const chain = services.evm.base();
    const address = await daoAddress(dao);
    const held = await services.evm.balances(chain, address, { usdc: chain.usdc, aUsdc: chain.aUsdc, aWeth: chain.aWeth }).catch(() => null);
    const lines = [
      `*The DAO's EVM address:* \`${address}\``,
      "The same on every EVM chain; only the DAO's proposals can sign for it.",
      held
        ? `On ${chain.name}: ${fromUnits(held.eth, ETH_DECIMALS, 6)} ETH · ${fromUnits(held.usdc, USDC_DECIMALS)} USDC\nSupplied to Aave: ${fromUnits(held.aWeth, ETH_DECIMALS, 6)} ETH · ${fromUnits(held.aUsdc, USDC_DECIMALS)} USDC`
        : `Couldn't read ${chain.name} right now.`,
      `Send it funds through NEAR Intents with \`${ctx.cmd("paychain")} <amount> <token>@base dao <description>\`.`,
    ];
    return reply(lines.join("\n"));
  },
};

/** What /aave can supply: the token, its decimals, and the calls for each action. */
const AAVE_ASSETS = {
  USDC: { decimals: USDC_DECIMALS, places: 6, held: "usdc", supplied: "aUsdc", supply: "aaveSupplyCalls", withdraw: "aaveWithdrawCalls" },
  ETH: { decimals: ETH_DECIMALS, places: 6, held: "eth", supplied: "aWeth", supply: "aaveSupplyEthCalls", withdraw: "aaveWithdrawEthCalls" },
};

const aave = {
  section: "Treasury",
  needsDao: true,
  usage: "supply|withdraw <amount|all> [USDC|ETH]",
  description: "Propose supplying or withdrawing the DAO's USDC or ETH on Aave (Base), from its own EVM address",
  options: [
    { name: "action", description: "supply or withdraw", required: true, choices: ["supply", "withdraw"] },
    { name: "amount", description: "How much, or all (withdraw)", required: true },
    { name: "asset", description: "USDC (default) or ETH", required: false, choices: ["USDC", "ETH"] },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("aave")} supply|withdraw <amount|all> [USDC|ETH]`;
    const dao = requireDao(ctx);
    const [action, rawAmount, rawAsset = "USDC"] = [String(ctx.args[0] ?? "").toLowerCase(), ctx.args[1], ctx.args[2]];
    if (action !== "supply" && action !== "withdraw") throw new UserError(`Usage: \`${usage}\``);
    const symbol = String(rawAsset).toUpperCase();
    const asset = AAVE_ASSETS[symbol];
    if (!asset) throw new UserError(`Aave here takes USDC or ETH. Usage: \`${usage}\``);
    const chain = services.evm.base();
    const from = await daoAddress(dao);
    const held = await services.evm.balances(chain, from, { usdc: chain.usdc, aUsdc: chain.aUsdc, aWeth: chain.aWeth }).catch((err) => {
      throw new UserError(`Couldn't reach ${chain.name}: ${err.message}`);
    });
    const show = (units) => `${fromUnits(units, asset.decimals, asset.places)} ${symbol}`;
    if (action === "withdraw" && String(rawAmount).toLowerCase() === "all") {
      if (held[asset.supplied] === 0n) throw new UserError(`The DAO has no ${symbol} on Aave.`);
      return proposeEvm(ctx, dao, `Withdraw all ${symbol} (about ${show(held[asset.supplied])}) from Aave`, services.evm[asset.withdraw](chain, from, null));
    }
    const amount = parseAmount(rawAmount, asset.decimals, usage);
    if (action === "supply") {
      if (held[asset.held] < amount) {
        throw new UserError(`The DAO's ${chain.name} address has ${show(held[asset.held])}. Send it ${symbol} with \`${ctx.cmd("paychain")} <amount> ${symbol}@base dao <description>\`.`);
      }
      return proposeEvm(ctx, dao, `Supply ${show(amount)} to Aave`, services.evm[asset.supply](chain, from, amount));
    }
    if (held[asset.supplied] < amount) throw new UserError(`The DAO has ${show(held[asset.supplied])} on Aave.`);
    return proposeEvm(ctx, dao, `Withdraw ${show(amount)} from Aave`, services.evm[asset.withdraw](chain, from, amount));
  },
};

export const EVM_COMMANDS = { evm, aave };
