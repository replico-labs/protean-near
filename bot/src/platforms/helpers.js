import { NEAR_DECIMALS, toUnits, fromUnits } from "../near/amounts.js";
import { ChainError } from "../near/client.js";
import { EXPLORER_URL, NETWORK_ID } from "../config.js";
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

/**
 * This chat's DAO link, or a UserError explaining how to get one. With
 * `models`, also requires the DAO to run one of them.
 */
export function requireDao(ctx, models) {
  const link = services.db.getChatDao(ctx.platform, ctx.chatId);
  if (!link) throw new UserError(`This chat has no DAO yet. An admin can create one with \`${ctx.cmd("createdao")} <name> <SYMBOL> <supply> [model]\` or link one with \`${ctx.cmd("link")}\`.`);
  if (models && !models.includes(link.model)) {
    throw new UserError(`That's for ${models.join(" or ")} DAOs; this chat's DAO is *${link.model}*. See \`${ctx.cmd("help")}\`.`);
  }
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

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A NEAR account ID, or a UserError. "me" is the caller's own account. */
export async function parseAccountId(ctx, raw, usage) {
  if (String(raw).toLowerCase() === "me") return (await userAccount(ctx)).accountId;
  const id = String(raw ?? "").toLowerCase();
  if (id.length < 2 || id.length > 64 || !ACCOUNT_ID.test(id)) throw new UserError(`\`${raw ?? ""}\` isn't a NEAR account. Usage: \`${usage}\``);
  return id;
}

/**
 * Who to send to: a NEAR account, "me", or a chat member, by replying to
 * one of their messages (Telegram) or mentioning them (Discord). A member
 * without a bot account yet gets one, so what's sent waits for them there.
 */
export async function recipientAccount(ctx, raw, usage) {
  const mentioned = /^<@!?(\d+)>$/.exec(raw ?? "")?.[1];
  const member = mentioned ?? (raw === undefined ? ctx.replyTo?.userId : undefined);
  if (member) {
    if (!services.isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
    return (await services.wallets.getOrCreateUserAccount(ctx.platform, member)).accountId;
  }
  if (String(raw ?? "").startsWith("@")) {
    throw new UserError(`I can't find an account from a username. Reply to one of ${raw}'s messages with \`${usage.replace(/ <(account|to)>.*$/, "")}\`, or use the account their \`${ctx.cmd("wallet")}\` shows.`);
  }
  return parseAccountId(ctx, raw, usage);
}

/** An account as a link to the explorer (a plain name on a local sandbox). */
export const accountLink = (id) => (NETWORK_ID === "sandbox" ? `\`${id}\`` : `[${id}](${EXPLORER_URL}/address/${id})`);

/** A user's or treasury's account: the name to tap and copy, then its explorer link beside it. */
export const copyableAccount = (id) => (NETWORK_ID === "sandbox" ? `\`${id}\`` : `\`${id}\` · [Explorer](${EXPLORER_URL}/address/${id})`);

/** " · View transaction", linking a transaction on the explorer, or "" without one. */
export const txLink = (hash) => (hash && NETWORK_ID !== "sandbox" ? ` · [View transaction](${EXPLORER_URL}/txns/${hash})` : "");

export function choiceOf(raw, usage) {
  const choice = { for: "For", yes: "For", against: "Against", no: "Against", abstain: "Abstain" }[String(raw).toLowerCase()];
  if (!choice) throw new UserError(`Usage: \`${usage}\``);
  return choice;
}

export const formatNear = (yocto) => fromUnits(yocto, NEAR_DECIMALS);

/** The chat's token: id, symbol and decimals. */
export async function tokenInfo(link) {
  const meta = await services.staking.tokenMetadata(link.tokenId);
  return { id: link.tokenId, symbol: meta.symbol, decimals: meta.decimals, format: (units) => `${fromUnits(units, meta.decimals)} ${meta.symbol}` };
}

/** Nanoseconds as "2 days", "5 hours", "30 minutes". */
export function formatDuration(ns) {
  const minutes = Number(BigInt(ns) / 60_000_000_000n);
  if (minutes >= 2 * 24 * 60) return `${Math.round(minutes / (24 * 60))} days`;
  if (minutes >= 2 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Nanoseconds since the epoch as a UTC time. */
export function formatTime(ns) {
  return `${new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const nowNs = () => BigInt(Date.now()) * 1_000_000n;

/** Runs `fn`; a contract error with code `code` becomes a UserError with `message`. */
export async function explain(fn, messages) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ChainError && messages[err.code]) throw new UserError(messages[err.code]);
    throw err;
  }
}
