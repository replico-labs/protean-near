import { VENUES, LST_NAMES } from "./venues.js";
import { view } from "./client.js";

/**
 * Liquid staking (LiNEAR, Meta Pool, Stader's NearX): the treasury stakes
 * NEAR and holds the protocol's token, which keeps earning. All three follow
 * NEAR's staking-pool interface for staking, unstaking and their views; Meta
 * Pool names its withdraw differently.
 */

const WITHDRAW_METHOD = { linear: "withdraw_all", metapool: "withdraw_unstaked", nearx: "withdraw_all" };

/** The configured providers, as [key, account]. */
export const providers = () => Object.entries(VENUES.lst).filter(([, id]) => id);

/** The account and withdraw method for provider `key` (default: the first configured). */
export function provider(key) {
  const [name, id] = key ? [key, VENUES.lst[key]] : (providers()[0] ?? []);
  if (!id) throw new Error(`Liquid staking ${key ? `"${key}" ` : ""}isn't configured on this network`);
  return { key: name, id, label: LST_NAMES[name] ?? name, withdrawMethod: WITHDRAW_METHOD[name] ?? "withdraw_all" };
}

/** What `accountId` has with provider `id`: staked and unstaked NEAR, and whether the unstaked part can be withdrawn. */
export async function position(id, accountId) {
  const [staked, unstaked, available] = await Promise.all([
    view(id, "get_account_staked_balance", { account_id: accountId }),
    view(id, "get_account_unstaked_balance", { account_id: accountId }),
    view(id, "is_account_unstaked_balance_available", { account_id: accountId }),
  ]);
  return { staked: BigInt(staked), unstaked: BigInt(unstaked), available };
}
