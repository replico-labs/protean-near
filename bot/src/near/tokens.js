import { VENUES } from "./venues.js";
import { view } from "./client.js";
import { fromUnits, NEAR_DECIMALS } from "./amounts.js";

/**
 * Tokens other than the DAO's own: what a typed symbol means, and their
 * names and decimals (from ft_metadata, kept once loaded) for amounts.
 */

const metadata = new Map([["NEAR", { symbol: "NEAR", decimals: NEAR_DECIMALS }]]);

/** Loads metadata for `ids`; ones that fail are left out and shown raw. */
export async function load(ids) {
  await Promise.all(
    [...new Set(ids)]
      .filter((id) => !metadata.has(id))
      .map((id) =>
        view(id, "ft_metadata")
          .then((m) => metadata.set(id, { symbol: m.symbol, decimals: m.decimals }))
          .catch(() => {}),
      ),
  );
}

/** `id`'s metadata, loading it if needed; throws if `id` isn't a token. */
export async function info(id) {
  await load([id]);
  const m = metadata.get(id);
  if (!m) throw new Error(`${id} isn't a NEP-141 token`);
  return m;
}

/** `amount` of `id` in its own units, e.g. "12.5 USDC", or raw if its metadata isn't loaded. */
export function format(id, amount) {
  const m = metadata.get(id);
  return m ? `${fromUnits(BigInt(amount), m.decimals, Math.min(m.decimals, 8))} ${m.symbol}` : `${amount} of ${id}`;
}

/**
 * What `text` names: "NEAR", the DAO's token by its symbol, a known symbol
 * such as USDC, or a token account. Returns "NEAR" or an account ID, or null.
 */
export function resolve(text, daoToken) {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper === "NEAR") return "NEAR";
  if (daoToken && upper === daoToken.symbol.toUpperCase()) return daoToken.id;
  const known = Object.entries(VENUES.tokens).find(([symbol]) => symbol.toUpperCase() === upper);
  if (known) return known[1];
  return /^[a-z0-9_\-.]{2,64}$/.test(text) && (text.includes(".") || text.length === 64) ? text : null;
}
