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
  const gas = txs.reduce((sum, t) => sum + t.maxCost, 0n);
  const { eth } = await services.evm.balances(chain, from, {});
  if (eth < gas) throw new UserError(`The DAO's ${chain.name} address \`${from}\` needs up to ${fromUnits(gas, ETH_DECIMALS, 6)} ETH for gas and has ${fromUnits(eth, ETH_DECIMALS, 6)}. ${fundingHint(ctx.cmd)}`);
  await userAccount(ctx);
  const kind = services.chainsig.signKind(txs.map((t) => t.hash));
  const text = services.evm.withTxs(`${description} (on ${chain.name}, from the DAO's address ${from})`, { chain: chain.chainId, from, txs: txs.map((t) => t.serialized) });
  return makeProposal(ctx, dao, text, kind);
}

/**
 * After a proposal carrying EVM transactions executes: takes the signatures
 * from the execution's outcome, checks each was made by the DAO's address,
 * sends the transactions in order, and says what happened.
 */
export async function relayEvm(payload, outcome) {
  if (payload.hyperliquid) return relayHyperliquid(payload, outcome);
  const chain = services.evm.base();
  const signatures = services.chainsig.signaturesFrom(outcome);
  if (signatures.length !== payload.txs.length) {
    return `\n\n⚠️ Expected ${payload.txs.length} signature(s) for ${chain.name}, found ${signatures.length}. Nothing was sent.`;
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
      break;
    }
    try {
      lines.push(`✅ Sent on ${chain.name}: \`${await services.evm.broadcast(chain, signed)}\``);
    } catch (err) {
      lines.push(`⚠️ Transaction ${i + 1} wasn't sent: ${err.message}`);
      break;
    }
  }
  return `\n\n${lines.join("\n")}`;
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
        lines.push(`✅ Hyperliquid accepted ${action.type === "approveAgent" ? `the agent ${action.agentAddress}` : `sending ${action.amount} USDC to ${action.destination}`}`);
        done = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!done) {
      lines.push(`⚠️ Hyperliquid didn't take it: ${lastError?.message ?? "no signature from the DAO's address"}`);
      break;
    }
  }
  return `\n\n${lines.join("\n")}`;
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
    const held = await services.evm.balances(chain, address, { usdc: chain.usdc, aUsdc: chain.aUsdc }).catch(() => null);
    const lines = [
      `*The DAO's EVM address:* \`${address}\``,
      "The same on every EVM chain; only the DAO's proposals can sign for it.",
      held
        ? `On ${chain.name}: ${fromUnits(held.eth, ETH_DECIMALS, 6)} ETH · ${fromUnits(held.usdc, USDC_DECIMALS)} USDC · ${fromUnits(held.aUsdc, USDC_DECIMALS)} USDC supplied to Aave`
        : `Couldn't read ${chain.name} right now.`,
      `Send it funds through NEAR Intents with \`${ctx.cmd("paychain")} <amount> <token>@base dao <description>\`.`,
    ];
    return reply(lines.join("\n"));
  },
};

const aave = {
  section: "Treasury",
  needsDao: true,
  usage: "supply|withdraw <amount|all>",
  description: "Propose supplying or withdrawing the DAO's USDC on Aave (Base), from its own EVM address",
  options: [
    { name: "action", description: "supply or withdraw", required: true, choices: ["supply", "withdraw"] },
    { name: "amount", description: "USDC, or all (withdraw)", required: true },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("aave")} supply|withdraw <amount|all>`;
    const dao = requireDao(ctx);
    const [action, rawAmount] = [String(ctx.args[0] ?? "").toLowerCase(), ctx.args[1]];
    if (action !== "supply" && action !== "withdraw") throw new UserError(`Usage: \`${usage}\``);
    const chain = services.evm.base();
    const from = await daoAddress(dao);
    const held = await services.evm.balances(chain, from, { usdc: chain.usdc, aUsdc: chain.aUsdc }).catch((err) => {
      throw new UserError(`Couldn't reach ${chain.name}: ${err.message}`);
    });
    if (action === "withdraw" && String(rawAmount).toLowerCase() === "all") {
      if (held.aUsdc === 0n) throw new UserError("The DAO has no USDC on Aave.");
      return proposeEvm(ctx, dao, `Withdraw all USDC (about ${fromUnits(held.aUsdc, USDC_DECIMALS)}) from Aave`, services.evm.aaveWithdrawCalls(chain, from, null));
    }
    const amount = parseAmount(rawAmount, USDC_DECIMALS, usage);
    if (action === "supply") {
      if (held.usdc < amount) throw new UserError(`The DAO's ${chain.name} address has ${fromUnits(held.usdc, USDC_DECIMALS)} USDC. Send it USDC with \`${ctx.cmd("paychain")} <amount> USDC@base dao <description>\`.`);
      return proposeEvm(ctx, dao, `Supply ${fromUnits(amount, USDC_DECIMALS)} USDC to Aave`, services.evm.aaveSupplyCalls(chain, from, amount));
    }
    if (held.aUsdc < amount) throw new UserError(`The DAO has ${fromUnits(held.aUsdc, USDC_DECIMALS)} USDC on Aave.`);
    return proposeEvm(ctx, dao, `Withdraw ${fromUnits(amount, USDC_DECIMALS)} USDC from Aave`, services.evm.aaveWithdrawCalls(chain, from, amount));
  },
};

export const EVM_COMMANDS = { evm, aave };
