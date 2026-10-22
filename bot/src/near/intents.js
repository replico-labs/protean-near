import { NETWORK_ID } from "../config.js";
import { view, operatorAccount } from "./client.js";
import { ensureTokenStorage } from "./staking.js";
import { VENUES } from "./venues.js";

/**
 * NEAR Intents, through its 1Click API: quotes for buying any token it
 * lists and for paying out on 30+ chains. The DAO acts by proposal: it
 * funds a quote by depositing into the quote's account inside NEAR Intents
 * (kinds.intentsDeposit), and solvers deliver. Unfilled quotes refund to the
 * DAO's own NEAR Intents account, which it can withdraw from by proposal.
 *
 * NEAR Intents runs on mainnet. ONECLICK_JWT (optional) avoids the fee 1Click
 * charges unauthenticated requests.
 */

const API = process.env.ONECLICK_URL || "https://1click.chaindefuser.com";
const TOKENS_TTL_MS = 10 * 60_000;
let tokenCache = { at: 0, tokens: [] };

/** The NEAR Intents contract; mainnet unless INTENTS_ID points elsewhere. */
export function intentsId() {
  if (process.env.INTENTS_ID) return process.env.INTENTS_ID;
  if (NETWORK_ID !== "mainnet") throw new Error("NEAR Intents runs on mainnet; this bot is on " + NETWORK_ID);
  return "intents.near";
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (process.env.ONECLICK_JWT) headers.authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`NEAR Intents: ${data.message ?? res.statusText}`);
  return data;
}

/** Every asset 1Click trades: { assetId, symbol, blockchain, decimals, contractAddress, price }. Cached ten minutes. */
export async function tokens() {
  if (Date.now() - tokenCache.at < TOKENS_TTL_MS && tokenCache.tokens.length) return tokenCache.tokens;
  tokenCache = { at: Date.now(), tokens: await api("/v0/tokens") };
  return tokenCache.tokens;
}

/**
 * The asset `text` names: "BTC", or with a chain, "USDC@base". Without a
 * chain, a token's native chain wins (BTC on btc), then NEAR. Returns the
 * asset or null; throws listing the chains if the symbol is on several and
 * none is the obvious one.
 */
export async function findAsset(text) {
  const [symbol, chain] = String(text ?? "").split("@").map((s) => s.trim().toLowerCase());
  const matches = (await tokens()).filter((t) => t.symbol.toLowerCase() === symbol && (!chain || t.blockchain === chain));
  if (matches.length <= 1) return matches[0] ?? null;
  const preferred = matches.find((t) => t.blockchain === symbol) ?? matches.find((t) => t.blockchain === "near");
  if (preferred && !chain) return preferred;
  throw new Error(`${symbol.toUpperCase()} is on ${matches.map((t) => t.blockchain).join(", ")}; pick one, e.g. ${symbol.toUpperCase()}@${matches[0].blockchain}`);
}

/** The asset for a token the treasury holds on NEAR ("NEAR" trades as wrapped NEAR), or null if 1Click doesn't trade it. */
export async function nearAsset(tokenId, wrapNear) {
  const id = `nep141:${tokenId === "NEAR" ? wrapNear : tokenId}`;
  return (await tokens()).find((t) => t.assetId === id) ?? null;
}

/**
 * A live quote, funded from the DAO's NEAR treasury: `amount` is what goes
 * in (EXACT_INPUT) or what the recipient gets (EXACT_OUTPUT). The deposit
 * goes to an account inside NEAR Intents; refunds go to the DAO's own NEAR
 * Intents account. `deadline` (a Date) must cover the whole time until the
 * proposal can no longer execute: depositing after it can lose the funds.
 */
export async function quote({ dao, from, to, amount, exactOutput = false, recipient, recipientType, slippageBps, deadline }) {
  const response = await api("/v0/quote", {
    method: "POST",
    body: {
      dry: false,
      swapType: exactOutput ? "EXACT_OUTPUT" : "EXACT_INPUT",
      slippageTolerance: slippageBps,
      originAsset: from.assetId,
      depositType: "INTENTS",
      destinationAsset: to.assetId,
      amount: String(amount),
      refundTo: dao,
      refundType: "INTENTS",
      recipient,
      recipientType,
      deadline: deadline.toISOString(),
      referral: "protean",
    },
  });
  return response.quote ? { ...response.quote, correlationId: response.correlationId, signature: response.signature } : null;
}

/** Where a funded quote is: PENDING_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED... */
export async function status(depositAddress) {
  return api(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
}

/** The DAO's NEAR Intents balance of `assetId` (e.g. "nep141:wrap.near"). */
export async function balanceOf(accountId, assetId) {
  return BigInt(await view(intentsId(), "mt_balance_of", { account_id: accountId, token_id: assetId }));
}

/**
 * Registers the DAO with the NEP-141 tokens a proposal will touch on NEAR,
 * paid by the operator: wrapped NEAR when it pays in NEAR (it's wrapped
 * first), `token` itself otherwise, and the bought token when it's
 * delivered to the treasury on NEAR.
 */
export async function prepareDao(daoId, token, to) {
  const ids = [token === "NEAR" ? VENUES.wrapNear : token];
  if (to?.blockchain === "near" && to.assetId.startsWith("nep141:")) ids.push(to.assetId.slice("nep141:".length));
  for (const id of new Set(ids)) await ensureTokenStorage(operatorAccount(), id, daoId);
}

/** What the DAO holds inside NEAR Intents, as [assetId, amount] with amount > 0. */
export async function holdings(accountId) {
  const contract = intentsId();
  const owned = await view(contract, "mt_tokens_for_owner", { account_id: accountId, limit: 100 });
  const ids = owned.map((t) => t.token_id);
  if (!ids.length) return [];
  const balances = await view(contract, "mt_batch_balance_of", { account_id: accountId, token_ids: ids });
  return ids.map((id, i) => [id, BigInt(balances[i])]).filter(([, amount]) => amount > 0n);
}
