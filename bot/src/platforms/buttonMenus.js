import { NEAR_DECIMALS } from "../near/amounts.js";
import { services } from "./services.js";
import { UserError, tokenInfo, formatNear } from "./helpers.js";

/**
 * Second steps behind some proposal buttons (buttons.js), for actions one
 * press shouldn't do alone:
 *
 * - `ask amount <command> <id> <words>`: how much to put in, for taking a
 *   Sowellian position, splitting, or trading a decision market. It offers
 *   10%, 25%, 50% and all of what the presser holds for it, read when they
 *   press, as buttons that run the command with that amount.
 * - `ask sure <command> <id> <words>`: a confirmation for what posts a bond
 *   (proposing or disputing a Sowellian outcome).
 *
 * The menu goes only to the presser on Discord; on Telegram it's posted in
 * the group, addressed to them. Its text starts in lower case, to follow
 * the presser's name (menuText() capitalizes it where there's none). Whichever button they press next runs like
 * any other.
 */

const SHARES = [10, 25, 50, 100];
const GONE = "That button doesn't do anything any more.";

/** `ask ...` words -> { text, buttons } for the presser. Throws a UserError with a message to show. */
export async function buttonMenu(ctx, args) {
  const [kind, name, id, ...rest] = args;
  const dao = services.db.getChatDao(ctx.platform, ctx.chatId);
  if (!dao) throw new UserError("This chat isn't linked to a DAO any more.");
  if (!/^\d+$/.test(id ?? "")) throw new UserError(GONE);
  if (kind === "sure") return sureMenu(ctx, dao, name, id, rest);
  if (kind === "amount" && AMOUNTS[name]) return amountMenu(ctx, dao, name, id, rest);
  throw new UserError(GONE);
}

const OUTCOME = { success: "it met its goal", failure: "it didn't meet its goal" };

async function sureMenu(ctx, dao, name, id, [outcome]) {
  if (dao.model !== "sowellian") throw new UserError(GONE);
  const settings = services.orbit.modelOf(await services.orbit.getModel(dao.orbitId)).settings;
  const token = await tokenInfo(dao);
  const status = [{ label: "🔄 Status", cmd: `proposal ${id}` }];
  if (name === "dispute") {
    return {
      text: `dispute the proposed outcome of #${id}? It posts the ${token.format(settings.challenge_bond)} dispute bond from your account and opens a vote of stakers on what really happened. You lose the bond if the vote goes against you.`,
      buttons: [[{ label: "⚔️ Yes, dispute it", cmd: `dispute ${id}` }], status],
    };
  }
  if (name === "proposeresolution" && OUTCOME[outcome]) {
    return {
      text: `propose that ${OUTCOME[outcome]} for #${id}? It posts the ${token.format(settings.resolution_bond)} resolution bond from your account. Anyone can dispute it, and you lose the bond if a dispute wins.`,
      buttons: [[{ label: `📣 Yes, ${OUTCOME[outcome]}`, cmd: `proposeresolution ${id} ${outcome}` }], status],
    };
  }
  throw new UserError(GONE);
}

/**
 * Per command: the question, the presser's balance for it, and the command
 * for an amount (amounts go in different places).
 */
const AMOUNTS = {
  position: {
    model: "sowellian",
    words: (w) => ["yes", "no"].includes(w[0]),
    question: (id, [side]) => `how much do you want to put behind *${side === "yes" ? "YES (it works)" : "NO (it doesn't)"}* on #${id}?`,
    command: (id, [side], amount) => `position ${id} ${side} ${amount}`,
    typed: (cmd, id, [side]) => `\`${cmd("position")} ${id} ${side} <amount>\``,
    async have(ctx, dao, me, token) {
      return { raw: await services.staking.tokenBalance(token.id, me), decimals: token.decimals, unit: token.symbol, empty: `you have no unstaked ${token.symbol} to put in.` };
    },
  },
  split: {
    model: "decisionMarkets",
    words: (w) => ["near", "token"].includes(w[0]),
    question: (id, [asset], token) => `how much ${asset === "near" ? "NEAR" : token.symbol} do you want to split into pass and fail units on #${id}?`,
    command: (id, [asset], amount) => `split ${id} ${amount} ${asset}`,
    typed: (cmd, id, [asset], token) => `\`${cmd("split")} ${id} <amount> ${asset === "near" ? "NEAR" : token.symbol}\``,
    async have(ctx, dao, me, token, [asset]) {
      if (asset === "token") return { raw: await services.staking.tokenBalance(token.id, me), decimals: token.decimals, unit: token.symbol, empty: `you have no unstaked ${token.symbol} to split.` };
      // The split call itself holds NEAR for gas until it finishes.
      const [available, hold] = await Promise.all([services.wallets.availableBalance(me), services.wallets.gasHoldNear()]);
      return { raw: available > hold ? available - hold : 0n, decimals: NEAR_DECIMALS, unit: "NEAR", empty: `your account has no NEAR to spare beyond ${formatNear(hold)} for gas. Send some to it first (\`${ctx.cmd("wallet")}\`).` };
    },
  },
  trade: {
    model: "decisionMarkets",
    words: (w) => ["pass", "fail"].includes(w[0]) && ["near", "token"].includes(w[1]),
    question: (id, [market, asset], token) =>
      asset === "near" ? `how much of your ${market} NEAR do you want to spend on the token in #${id}'s *${market}* market?` : `how many of your ${market} ${token.symbol} do you want to sell in #${id}'s *${market}* market?`,
    command: (id, [market, asset], amount) => `trade ${id} ${market} ${amount} ${asset}`,
    typed: (cmd, id, [market, asset], token) => `\`${cmd("trade")} ${id} ${market} <amount> ${asset === "near" ? "NEAR" : token.symbol}\``,
    async have(ctx, dao, me, token, [market, asset], id) {
      const units = (await services.orbit.getHoldings(dao.orbitId, id, me)) ?? {};
      const raw = BigInt(units[`${market}_${asset}`] ?? 0);
      const unit = `${market} ${asset === "near" ? "NEAR" : token.symbol}`;
      const splitWhat = asset === "near" ? "NEAR" : token.symbol;
      return { raw, decimals: asset === "near" ? NEAR_DECIMALS : token.decimals, unit, empty: `you hold no ${unit} units. Split some first: \`${ctx.cmd("split")} ${id} <amount> ${splitWhat}\`.` };
    },
  },
};

/** `pct`% of `raw` as a decimal with at most `places` decimals, rounded down; null if that's 0. */
export function share(raw, decimals, pct, places = 6) {
  const part = (BigInt(raw) * BigInt(pct)) / 100n;
  const base = 10n ** BigInt(decimals);
  const fraction = (part % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  const text = fraction ? `${part / base}.${fraction}` : `${part / base}`;
  return /^0(\.0*)?$/.test(text) ? null : text;
}

async function amountMenu(ctx, dao, name, id, words) {
  const spec = AMOUNTS[name];
  if (dao.model !== spec.model || !spec.words(words)) throw new UserError(GONE);
  const token = await tokenInfo(dao);
  const status = [{ label: "🔄 Status", cmd: `proposal ${id}` }];
  const me = await services.wallets.findUserAccountId(ctx.platform, ctx.userId);
  if (!me) return { text: `you don't have an account here yet: \`${ctx.cmd("wallet")}\` makes one.`, buttons: [status] };
  const have = await spec.have(ctx, dao, me, token, words, id);
  if (have.raw <= 0n) return { text: have.empty, buttons: [status] };

  const choices = [];
  for (const pct of SHARES) {
    const amount = share(have.raw, have.decimals, pct);
    const cmd = amount && spec.command(id, words, amount);
    // Telegram carries at most 64 bytes per button (buttons.js).
    if (!amount || choices.some((c) => c.amount === amount) || Buffer.byteLength(`c:${cmd}`) > 64) continue;
    choices.push({ amount, label: `${pct === 100 ? "All" : `${pct}%`}: ${amount}`, cmd });
  }
  const rows = [choices.slice(0, 2), choices.slice(2), status].filter((r) => r.length);
  return {
    text: `${spec.question(id, words, token)} You have ${share(have.raw, have.decimals, 100) ?? "0"} ${have.unit}.\nOr type ${spec.typed(ctx.cmd, id, words, token)}.`,
    buttons: rows.map((r) => r.map(({ label, cmd }) => ({ label, cmd }))),
  };
}

/** A menu's text on its own, with no name before it. */
export const menuText = (text) => text.charAt(0).toUpperCase() + text.slice(1);
