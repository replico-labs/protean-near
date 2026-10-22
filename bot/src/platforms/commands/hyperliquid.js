import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { fromUnits } from "../../near/amounts.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount, formatTime } from "../helpers.js";
import { makeProposal } from "./proposing.js";

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
    return reply(
      [
        `*Hyperliquid account* \`${address}\``,
        `Value: $${account.accountValue} · Withdrawable: ${account.withdrawable} USDC`,
        positions,
        `Fund it: \`${ctx.cmd("paychain")} <amount> USDC@hypercore dao <description>\``,
      ].join("\n"),
    );
  },
};

const hlagent = {
  section: "Treasury",
  needsDao: true,
  usage: "<address> [name]",
  description: "Propose a Hyperliquid trading agent for the DAO: it can trade, never withdraw",
  options: [
    { name: "address", description: "The agent's EVM address (a trader, a bot, an AI agent)", required: true },
    { name: "name", description: `Agent name (default ${DEFAULT_AGENT}); a new agent with the same name replaces the old one`, required: false },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("hlagent")} <address> [name]`;
    const dao = requireDao(ctx);
    const [agent, name = DEFAULT_AGENT] = ctx.args;
    if (!EVM_ADDRESS.test(agent ?? "")) throw new UserError(`\`${agent ?? ""}\` isn't an EVM address. Usage: \`${usage}\``);
    const { nonce, validUntil } = services.hyperliquid.nonceForProposal();
    const action = services.hyperliquid.approveAgent(agent, name, nonce);
    return proposeHyperliquid(ctx, dao, `Appoint ${agent} as the DAO's Hyperliquid trading agent "${name}": it can place and cancel orders, but not withdraw`, [action], validUntil);
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

export const HYPERLIQUID_COMMANDS = { hyperliquid, hlagent, hlrevoke, hlsend };
