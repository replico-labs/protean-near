import { NEAR_DECIMALS } from "../../near/amounts.js";
import { isStakeModel } from "../../near/models.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount, parseAccountId, formatNear, tokenInfo, explain } from "../helpers.js";

const wallet = {
  section: "Your wallet",
  usage: "",
  description: "Your NEAR account, balances and stake",
  ephemeralByDefault: true,
  options: [],
  async run(ctx) {
    const account = await userAccount(ctx);
    const near = await services.wallets.availableBalance(account.accountId);
    const lines = [`*Your account:* \`${account.accountId}\``, `NEAR: ${formatNear(near)}`];
    const dao = services.db.getChatDao(ctx.platform, ctx.chatId);
    if (dao) {
      const token = await tokenInfo(dao);
      const [balance, member] = await Promise.all([services.staking.tokenBalance(token.id, account.accountId), services.staking.getMember(dao.stakingId, account.accountId)]);
      lines.push(`${token.symbol}: ${token.format(balance)} in your account`);
      if (member) lines.push(`Staked: ${token.format(member.stake)}${member.locked > 0n ? ` (${token.format(member.locked)} locked backing a proposal)` : ""}`);
      if (dao.model === "liquid") {
        const to = await services.orbit.getDelegate(dao.orbitId, account.accountId);
        if (to) lines.push(`Your vote is delegated to \`${to}\``);
      }
      if (dao.model === "conviction") {
        const backing = await services.orbit.getSupport(dao.orbitId, account.accountId);
        if (backing) lines.push(`You back proposal #${backing[0]}`);
      }
    }
    return reply(lines.join("\n"), { ephemeral: true });
  },
};

const stake = {
  section: "Your wallet",
  usage: "<amount>",
  description: "Stake tokens: your stake is your voting weight (from the next proposal on)",
  options: [{ name: "amount", description: "How many tokens", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const amount = parseAmount(ctx.args[0], token.decimals, `${ctx.cmd("stake")} <amount>`);
    const account = await userAccount(ctx);
    const balance = await services.staking.tokenBalance(token.id, account.accountId);
    if (balance < amount) throw new UserError(`You have ${token.format(balance)}. Your account is \`${account.accountId}\`; get tokens sent there first.`);
    await services.staking.stake(account, token.id, dao.stakingId, amount);
    const member = await services.staking.getMember(dao.stakingId, account.accountId);
    const note = isStakeModel(dao.model) || dao.model === "delegate" || dao.model === "sortition" ? " It counts on proposals made from now on." : "";
    return reply(`✅ Staked ${token.format(amount)}. Your stake is now ${token.format(member.stake)}.${note}`);
  },
};

const unstake = {
  section: "Your wallet",
  usage: "<amount>",
  description: "Take staked tokens back to your account",
  options: [{ name: "amount", description: "How many tokens", required: true }],
  async run(ctx) {
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    const amount = parseAmount(ctx.args[0], token.decimals, `${ctx.cmd("unstake")} <amount>`);
    const account = await userAccount(ctx);
    await explain(() => services.staking.unstake(account, dao.stakingId, amount), {
      ERR_NOT_ENOUGH_UNLOCKED_STAKE: `You don't have that much unlocked stake. Stake backing a proposal is locked; \`${ctx.cmd("withdrawsupport")}\` releases it.`,
      ERR_NOT_REGISTERED: "You have nothing staked.",
    });
    return reply(`✅ Unstaked ${token.format(amount)} back to \`${account.accountId}\`.`);
  },
};

const send = {
  section: "Your wallet",
  usage: "<amount> <NEAR|token> <account>",
  description: "Send NEAR or the DAO's token from your account",
  options: [
    { name: "amount", description: "How much", required: true },
    { name: "currency", description: "NEAR, or the DAO's token symbol", required: true },
    { name: "to", description: "Receiving NEAR account", required: true },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("send")} <amount> <NEAR|token> <account>`;
    const [rawAmount, currency, rawTo] = ctx.args;
    const to = await parseAccountId(ctx, rawTo, usage);
    const account = await userAccount(ctx);
    if (currency?.toUpperCase() === "NEAR") {
      const amount = parseAmount(rawAmount, NEAR_DECIMALS, usage);
      await account.transfer({ receiverId: to, amount });
      return reply(`✅ Sent ${formatNear(amount)} NEAR to \`${to}\`.`);
    }
    const dao = requireDao(ctx);
    const token = await tokenInfo(dao);
    if (currency?.toUpperCase() !== token.symbol.toUpperCase()) throw new UserError(`Send NEAR or ${token.symbol}. Usage: \`${usage}\``);
    const amount = parseAmount(rawAmount, token.decimals, usage);
    await services.staking.sendToken(account, token.id, to, amount);
    return reply(`✅ Sent ${token.format(amount)} to \`${to}\`.`);
  },
};

export const WALLET_COMMANDS = { wallet, stake, unstake, send };
