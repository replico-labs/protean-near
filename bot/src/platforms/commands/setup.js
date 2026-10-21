import { MODELS, isCouncilModel } from "../../near/models.js";
import * as kinds from "../../near/kinds.js";
import { services } from "../services.js";
import { UserError, reply, requireDao, userAccount, parseAmount, parseAccountId, tokenInfo, explain } from "../helpers.js";
import { describeProposal, loadProposal } from "../proposals.js";

const MODEL_NAMES = Object.keys(MODELS);
const modelName = (raw) => MODEL_NAMES.find((m) => m.toLowerCase() === String(raw ?? "").toLowerCase());

/** Council members from the words after the model: NEAR accounts, or "me". */
async function councilFrom(ctx, words, usage) {
  const members = [];
  for (const word of words) members.push(await parseAccountId(ctx, word, usage));
  return [...new Set(members)];
}

const createdao = {
  section: "Setup",
  usage: "<name> <SYMBOL> <supply> [model] [members...]",
  description: "Create a DAO for this chat, with its token and governance (admins)",
  options: [
    { name: "name", description: "Lowercase name, e.g. ark", required: true },
    { name: "symbol", description: "Token symbol, e.g. ARK", required: true },
    { name: "supply", description: "Total token supply; you receive all of it", required: true },
    { name: "model", description: "Governance model (default tokenWeighted)", required: false, choices: MODEL_NAMES },
    { name: "members", description: "Board or starting council: NEAR accounts, or me", required: false, rest: true },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("createdao")} <name> <SYMBOL> <supply> [model] [members...]`;
    if (services.db.getChatDao(ctx.platform, ctx.chatId)) throw new UserError(`This chat already has a DAO. Run \`${ctx.cmd("unlink")}\` first to replace it.`);
    const [rawName, symbol, rawSupply, rawModel, ...rest] = ctx.args;
    const name = String(rawName ?? "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(name)) throw new UserError(`The name must be 2-31 lowercase letters, digits or dashes. Usage: \`${usage}\``);
    if (!/^[A-Za-z0-9]{2,10}$/.test(symbol ?? "")) throw new UserError(`The symbol must be 2-10 letters or digits. Usage: \`${usage}\``);
    const supply = parseAmount(rawSupply, 18, usage);
    const model = rawModel ? modelName(rawModel) : "tokenWeighted";
    if (!model) throw new UserError(`Unknown model \`${rawModel}\`. Choose one of: ${MODEL_NAMES.join(", ")}.`);
    const council = await councilFrom(ctx, rest, usage);
    if (model === "board" && council.length === 0) throw new UserError(`A board needs its members: \`${ctx.cmd("createdao")} ${name} ${symbol} ${rawSupply} board me alice.testnet\``);
    if (!isCouncilModel(model) && model !== "board" && council.length) throw new UserError(`Only board, delegate and sortition DAOs take members.`);

    const holder = (await userAccount(ctx)).accountId;
    const created = await services.deploy.createDao({ name, symbol: symbol.toUpperCase(), supply, model, council, holder });
    services.db.setChatDao(ctx.platform, ctx.chatId, { ...created, name, createdBy: String(ctx.userId), linkedBy: String(ctx.userId) });
    const next =
      model === "board"
        ? `Members propose with \`${ctx.cmd("pay")}\` or \`${ctx.cmd("signal")}\` and approve with \`${ctx.cmd("vote")}\`.`
        : `Send tokens to members with \`${ctx.cmd("send")}\`; they \`${ctx.cmd("stake")}\` to take part.`;
    return reply(
      [
        `🏛 *${name}* is live, with *${model}* governance.`,
        `DAO: \`${created.daoId}\``,
        created.orbitId ? `Orbit: \`${created.orbitId}\`` : `Members: ${council.map((m) => `\`${m}\``).join(", ")}`,
        `Token: ${rawSupply} ${symbol.toUpperCase()} (\`${created.tokenId}\`), all held by you (\`${holder}\`).`,
        "",
        next,
      ].join("\n")
    );
  },
};

const link = {
  section: "Setup",
  usage: "<dao> [orbit]",
  description: "Link this chat to an existing DAO: its orbit, or none for a board (admins)",
  options: [
    { name: "dao", description: "The Sputnik DAO, e.g. ark.sputnikv2.testnet", required: true },
    { name: "orbit", description: "Its orbit; leave out for a board DAO", required: false },
  ],
  async run(ctx) {
    const usage = `${ctx.cmd("link")} <dao> [orbit]`;
    const daoId = await parseAccountId(ctx, ctx.args[0], usage);
    const governing = await services.core.governingMembers(daoId).catch(() => {
      throw new UserError(`\`${daoId}\` isn't a Sputnik DAO.`);
    });
    if (!ctx.args[1]) {
      // A board made by this bot: its token and staking contract have the standard names.
      const name = daoId.split(".")[0];
      const ids = services.deploy.daoAccounts(name);
      if (ids.dao !== daoId || !(await services.staking.tokenMetadata(ids.token).catch(() => null))) {
        throw new UserError(`\`${daoId}\` wasn't created by this bot, so its token and staking contract are unknown. Link it through its orbit instead.`);
      }
      services.db.setChatDao(ctx.platform, ctx.chatId, { daoId, orbitId: null, model: "board", tokenId: ids.token, stakingId: ids.staking, name, linkedBy: String(ctx.userId) });
      return reply(`✅ Linked to the board DAO \`${daoId}\`. Members: ${governing.map((g) => `\`${g}\``).join(", ")}.`);
    }
    const orbitId = await parseAccountId(ctx, ctx.args[1], usage);
    const boundTo = await services.orbit.getDao(orbitId).catch(() => null);
    if (!boundTo) throw new UserError(`\`${orbitId}\` isn't an orbit.`);
    if (boundTo !== daoId) throw new UserError(`\`${orbitId}\` governs \`${boundTo}\`, not \`${daoId}\`.`);
    if (!governing.includes(orbitId)) throw new UserError(`\`${daoId}\` is governed by ${governing.map((g) => `\`${g}\``).join(", ") || "nobody"}, not \`${orbitId}\`.`);
    const [model, stakingId, tokenId] = await Promise.all([services.orbit.getModel(orbitId), services.orbit.getStakingContract(orbitId), services.orbit.getToken(orbitId)]);
    const name = services.orbit.modelOf(model).name;
    services.db.setChatDao(ctx.platform, ctx.chatId, { daoId, orbitId, model: name, tokenId, stakingId, name: daoId.split(".")[0], linkedBy: String(ctx.userId) });
    return reply(`✅ Linked to \`${daoId}\`, governed by \`${orbitId}\` (*${name}*).`);
  },
};

const unlink = {
  section: "Setup",
  needsDao: true,
  usage: "",
  description: "Unlink this chat's DAO (admins). The DAO itself is unchanged",
  options: [],
  async run(ctx) {
    requireDao(ctx);
    services.db.removeChatDao(ctx.platform, ctx.chatId);
    return reply("This chat is no longer linked to a DAO.");
  },
};

const switchmodel = {
  section: "Setup",
  needsDao: true,
  usage: "<model> [members...]",
  description: "Propose switching the DAO to another governance model; treasury and stakes stay",
  options: [
    { name: "model", description: "The new model", required: true, choices: MODEL_NAMES.filter((m) => m !== "board") },
    { name: "members", description: "Starting council for delegate or sortition", required: false, rest: true },
  ],
  async run(ctx) {
    const dao = requireDao(ctx);
    const usage = `${ctx.cmd("switchmodel")} <model> [members...]`;
    const model = modelName(ctx.args[0]);
    if (!model) throw new UserError(`Usage: \`${usage}\` - models: ${MODEL_NAMES.filter((m) => m !== "board").join(", ")}`);
    if (model === "board") throw new UserError("A DAO can't switch to a board: an orbit only hands the DAO to another orbit.");
    if (model === dao.model) throw new UserError(`The DAO already runs *${model}*.`);
    const council = await councilFrom(ctx, ctx.args.slice(1), usage);
    if (council.length && !isCouncilModel(model)) throw new UserError("Only delegate and sortition take a starting council.");
    const account = await userAccount(ctx);
    const token = await tokenInfo(dao);
    const supply = await services.staking.totalSupply(dao.tokenId);
    const newOrbit = await services.deploy.createOrbit({ name: dao.name, daoId: dao.daoId, tokenId: dao.tokenId, stakingId: dao.stakingId, model, supply, council });
    const description = `Switch governance to ${model} (${newOrbit})`;
    const kind = kinds.swap(newOrbit);
    const id = await explain(
      () => (dao.model === "board" ? services.core.addProposal(account, dao.daoId, description, kind) : services.orbit.propose(account, dao.orbitId, description, kind)),
      { ERR_NOT_COUNCIL_MEMBER: "Only council members can propose in this DAO.", ERR_PERMISSION_DENIED: "Only the board's members can propose." }
    );
    services.db.setChatDao(ctx.platform, ctx.chatId, { ...dao, pendingSwap: { orbitId: newOrbit, model, proposalId: id } });
    const p = await loadProposal(dao, id, token);
    return reply(`🔀 Proposed switching to *${model}*. The new orbit \`${newOrbit}\` is ready and takes over if this passes.\n\n${describeProposal(p, token)}`, { buttons: p.buttons });
  },
};

export const SETUP_COMMANDS = { createdao, link, unlink, switchmodel };
