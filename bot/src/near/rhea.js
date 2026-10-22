import { VENUES } from "./venues.js";
import { view, operatorAccount } from "./client.js";
import { ensureTokenStorage } from "./staking.js";

/**
 * Rhea (formerly Ref Finance), NEAR's main exchange: finding a swap route
 * and quoting it. The DAO swaps by proposal (kinds.rheaSwap), so a quote
 * only sets the proposal's minimum output; the price at execution decides.
 */

const PAGE = 200;
const POOLS_TTL_MS = 10 * 60_000;
let cache = { at: 0, exchange: null, pools: [] };

export function exchangeId() {
  if (!VENUES.rhea || !VENUES.wrapNear) throw new Error("Rhea isn't configured on this network (RHEA_EXCHANGE_ID, WRAP_NEAR_ID)");
  return VENUES.rhea;
}

/** Every Rhea pool, with its id; cached for ten minutes. */
async function pools() {
  const exchange = exchangeId();
  if (cache.exchange === exchange && Date.now() - cache.at < POOLS_TTL_MS) return cache.pools;
  const count = Number(await view(exchange, "get_number_of_pools"));
  const found = [];
  for (let from = 0; from < count; from += PAGE) {
    const page = await view(exchange, "get_pools", { from_index: from, limit: PAGE });
    page.forEach((pool, i) => found.push({ id: from + i, ...pool }));
  }
  cache = { at: Date.now(), exchange, pools: found };
  return found;
}

/** The pool that gives the most `b` for `amount` of `a`, as { pool_id, token_in, token_out, out }, or null. */
async function bestHop(a, b, amount) {
  const candidates = (await pools()).filter(
    (p) => p.token_account_ids.includes(a) && p.token_account_ids.includes(b) && p.amounts.every((x) => BigInt(x) > 0n),
  );
  let best = null;
  for (const pool of candidates) {
    const out = await view(exchangeId(), "get_return", { pool_id: pool.id, token_in: a, amount_in: String(amount), token_out: b })
      .then(BigInt)
      .catch(() => 0n);
    if (out > 0n && (!best || out > best.out)) best = { pool_id: pool.id, token_in: a, token_out: b, out };
  }
  return best;
}

/** Rhea's name for a token: "NEAR" trades as wrapped NEAR. */
const onRhea = (token) => (token === "NEAR" ? VENUES.wrapNear : token);

/**
 * The best route from `tokenIn` to `tokenOut` ("NEAR" or a token account)
 * for `amountIn`: one pool, or two through wrapped NEAR.
 * Returns { hops, out } or null if Rhea has no liquidity for the pair.
 */
export async function quote(tokenIn, tokenOut, amountIn) {
  const [a, b, wrap] = [onRhea(tokenIn), onRhea(tokenOut), VENUES.wrapNear];
  if (a === b) throw new Error("Pick two different tokens");
  const direct = await bestHop(a, b, amountIn);
  let best = direct && { hops: [direct], out: direct.out };
  if (a !== wrap && b !== wrap) {
    const first = await bestHop(a, wrap, amountIn);
    const second = first && (await bestHop(wrap, b, first.out));
    if (second && second.out > (best?.out ?? 0n)) best = { hops: [first, second], out: second.out };
  }
  return best;
}

/** Rhea's swap actions for `hops`: the amount goes in the first, the minimum in the last. */
export function routeActions(hops, amountIn, minOut) {
  return hops.map((h, i) => ({
    pool_id: h.pool_id,
    token_in: h.token_in,
    token_out: h.token_out,
    ...(i === 0 ? { amount_in: String(amountIn) } : {}),
    min_amount_out: i === hops.length - 1 ? String(minOut) : "0",
  }));
}

/** `amount` less `slippageBps` basis points: the least a swap proposal accepts. */
export const withSlippage = (amount, slippageBps) => (amount * BigInt(10_000 - slippageBps)) / 10_000n;

/**
 * Registers the DAO with the tokens a swap touches, paid by the operator.
 * Rhea keeps output it can't deliver instead of refunding it, so this must
 * happen before the proposal executes.
 */
export async function prepareDao(daoId, tokenIn, tokenOut) {
  const tokens = new Set([onRhea(tokenIn), onRhea(tokenOut)]);
  for (const token of tokens) await ensureTokenStorage(operatorAccount(), token, daoId);
}
