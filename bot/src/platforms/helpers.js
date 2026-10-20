import { NEAR_DECIMALS, toUnits, fromUnits } from "../near/amounts.js";
import { services } from "./services.js";

/**
 * Building blocks for the commands. Usage hints use ctx.cmd(), so they read
 * right on each platform.
 */

export const NO_WALLETS = "Accounts aren't set up on this bot yet - ask an admin to configure KMS and Supabase.";

/** An error whose message is safe and useful to show the user verbatim. */
export class UserError extends Error {}

export function reply(text, extra = {}) {
  return { text, ...extra };
}

/** This chat's DAO link, or a UserError explaining how to link one. */
export function requireDao(ctx) {
  const link = services.db.getChatDao(ctx.platform, ctx.chatId);
  if (!link) throw new UserError(`This chat isn't linked to a DAO yet. An admin can run \`${ctx.cmd("link")} <dao> <orbit>\`.`);
  return link;
}

/** The caller's NEAR account, signing with their key, with gas topped up. */
export async function userAccount(ctx) {
  if (!services.isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
  const account = await services.wallets.getOrCreateUserAccount(ctx.platform, ctx.userId);
  await services.wallets.ensureGas(account.accountId);
  return account;
}

export function parseId(raw, usage) {
  if (!raw || !/^\d+$/.test(raw)) throw new UserError(`Usage: \`${usage}\``);
  return Number(raw);
}

export function parseAmount(raw, decimals, usage) {
  const units = toUnits(raw, decimals);
  if (units === null) throw new UserError(`Usage: \`${usage}\` - the amount must be a positive number with at most ${decimals} decimals.`);
  return units;
}

/** A NEAR account ID, or a UserError. */
export function parseAccountId(raw, usage) {
  const id = String(raw ?? "").toLowerCase();
  const valid = id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
  if (!valid) throw new UserError(`\`${raw ?? ""}\` isn't a NEAR account. Usage: \`${usage}\``);
  return id;
}

export const formatNear = (yocto) => fromUnits(yocto, NEAR_DECIMALS);

/** The chat's token: id, symbol and decimals. */
export async function tokenInfo(link) {
  const meta = await services.tokenWeight.tokenMetadata(link.tokenId);
  return { id: link.tokenId, symbol: meta.symbol, decimals: meta.decimals };
}

/** Nanoseconds as "2 days", "5 hours", "30 minutes". */
export function formatDuration(ns) {
  const minutes = Number(BigInt(ns) / 60_000_000_000n);
  if (minutes >= 2 * 24 * 60) return `${Math.round(minutes / (24 * 60))} days`;
  if (minutes >= 2 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${minutes} minutes`;
}

/** Nanoseconds since the epoch as a UTC time. */
export function formatTime(ns) {
  return `${new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
