import { NEAR_DECIMALS } from "../../near/amounts.js";
import * as kinds from "../../near/kinds.js";
import { measurementPeriod } from "../../near/models.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount, parseAccountId, tokenInfo, explain } from "../helpers.js";
import { loadProposal, describeProposal } from "../proposals.js";

/** Makes a proposal on the chat's orbit, or for a board on the core, and shows it with its buttons. */
export async function makeProposal(ctx, dao, description, kind) {
  if (!description) throw new UserError("Add a description after the details, so people know what it's for.");
  const account = await userAccount(ctx);
  const token = await tokenInfo(dao);
  if (dao.model === "sowellian") return proposeSowellian(ctx, dao, account, token, description, kind);
  const id = await explain(
    () => (dao.model === "board" ? services.core.addProposal(account, dao.daoId, description, kind) : services.orbit.propose(account, dao.orbitId, description, kind)),
    {
      ERR_NOT_COUNCIL_MEMBER: "Only council members can propose in this DAO.",
      ERR_PERMISSION_DENIED: "Only the board's members can propose.",
      ERR_KIND_LOCKS_CORE: "That proposal would lock the DAO, so the orbit refuses it.",
    }
  );
  const p = await loadProposal(dao, id, token);
  let note = p.state === "Cancelled" ? `\n\n⚠️ Cancelled: you need more ${token.symbol} staked to propose here.` : "";
  if (dao.model === "decisionMarkets") note = `\n\nSeed its markets to open trading: \`${ctx.cmd("seed")} ${id} <tokens> <NEAR>\`.`;
  return reply(`📝 New proposal\n\n${describeProposal(p, token)}${note}`, { buttons: p.buttons });
}

/** A Sowellian proposal: success is judged by a human resolver after measuring; the bot posts the proposal bond. */
async function proposeSowellian(ctx, dao, account, token, description, kind) {
  const { settings } = services.orbit.modelOf(await services.orbit.getModel(dao.orbitId));
  const bond = BigInt(settings.proposal_bond);
  const balance = await services.staking.tokenBalance(token.id, account.accountId);
  if (balance < bond) throw new UserError(`Proposing takes a ${token.format(bond)} bond; you have ${token.format(balance)} unstaked.`);
  const id = await services.orbit.proposeWithCriteria(account, dao.orbitId, description, kind, measurementPeriod());
  if (bond > 0n) await services.orbit.sendToOrbit(account, token.id, dao.orbitId, bond, { proposal_bond: id });
  const p = await loadProposal(dao, id, token);
  return reply(`📝 New proposal, with a ${token.format(bond)} bond\n\n${describeProposal(p, token)}\n\nIf approved, bet on its success with \`${ctx.cmd("position")} ${id} yes|no <amount>\`.`, { buttons: p.buttons });
}

const pay = {
  section: "Proposing",
  usage: "<amount> <NEAR|token> <account> <description>",
  description: "Propose paying from the treasury",
  options: [
    { name: "amount", description: "How much", required: true },
    { name: "currency", description: "NEAR, or the DAO's token symbol", required: true },
    { name: "to", description: "Receiving NEAR account, or me", required: true },
    { name: "description", description: "What it's for", required: true, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("pay")} <amount> <NEAR|token> <account> <description>`;
    const [rawAmount, currency, rawTo, ...words] = ctx.args;
    const to = await parseAccountId(ctx, rawTo, usage);
    const token = await tokenInfo(dao);
    let kind;
    if (currency?.toUpperCase() === "NEAR") kind = kinds.transferNear(to, parseAmount(rawAmount, NEAR_DECIMALS, usage));
    else if (currency?.toUpperCase() === token.symbol.toUpperCase()) kind = kinds.transferToken(token.id, to, parseAmount(rawAmount, token.decimals, usage));
    else throw new UserError(`Pay in NEAR or ${token.symbol}. Usage: \`${usage}\``);
    return makeProposal(ctx, dao, words.join(" "), kind);
  },
};

const signal = {
  section: "Proposing",
  usage: "<question or statement>",
  description: "Propose a decision with nothing to execute",
  options: [{ name: "text", description: "The question or statement", required: true, rest: true }],
  async run(ctx) {
    return makeProposal(ctx, requireDao(ctx), ctx.args.join(" "), kinds.signal());
  },
};

export const PROPOSING_COMMANDS = { pay, signal };
