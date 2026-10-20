import { helpReply } from "../helpMenu.js";
import { MODELS } from "../near/models.js";
import { ChainError } from "../near/client.js";
import { services } from "./services.js";
import { UserError, reply } from "./helpers.js";
import { SETUP_COMMANDS } from "./commands/setup.js";
import { WALLET_COMMANDS } from "./commands/wallet.js";
import { DAO_COMMANDS } from "./commands/dao.js";
import { PROPOSING_COMMANDS } from "./commands/proposing.js";
import { DECIDING_COMMANDS } from "./commands/deciding.js";
import { COUNCIL_COMMANDS } from "./commands/council.js";
import { MARKET_COMMANDS } from "./commands/markets.js";

/**
 * Platform-neutral commands for the Telegram and Discord front-ends.
 *
 * Each command takes a context and returns a reply. Context:
 *   platform  "telegram" | "discord" - the chat-link and wallet key prefix
 *   chatId    the group or channel; one chat runs one DAO
 *   userId    platform user ID; one NEAR account per (platform, userId)
 *   args      positional words, in each command's `options` order
 *   isAdmin   true/false if the platform can tell, undefined if it can't
 *   isDirect  true in a one-to-one chat
 *   cmd(name) how this platform spells a command, for usage hints
 *
 * Replies use Telegram-style markdown (*bold*, `code`): { text, ephemeral?,
 * buttons? }. `options` drives Discord's slash commands; `section`, `usage`
 * and `models` (the models a command applies to) drive help.
 */

// Help sections, in order, and the topic word for each.
const SECTIONS = { Setup: "setup", "Your wallet": "wallet", "The DAO": "dao", Proposing: "proposing", Deciding: "deciding", Council: "council", Markets: "markets" };

const help = {
  section: "Help",
  usage: "[topic]",
  description: "The commands for this chat's DAO, by topic",
  ephemeralByDefault: true,
  options: [{ name: "topic", description: "One topic, or all", required: false, choices: [...Object.values(SECTIONS), "all"] }],
  async run(ctx) {
    const dao = services.db.getChatDao(ctx.platform, ctx.chatId);
    const applies = (c) => !c.models || (dao && c.models.includes(dao.model));
    const sections = Object.entries(SECTIONS).map(([title, key]) => ({
      key,
      title,
      lines: Object.entries(COMMANDS)
        .filter(([, c]) => c.section === title && applies(c))
        .map(([name, c]) => `\`${ctx.cmd(name)}${c.usage ? " " + c.usage : ""}\` — ${c.description}`),
    }));
    const intro = dao
      ? `*Protean on NEAR* — this chat runs \`${dao.daoId}\`\n${MODELS[dao.model]}`
      : `*Protean on NEAR* — no DAO here yet. Models for \`${ctx.cmd("createdao")}\`:\n${Object.entries(MODELS).map(([m, d]) => `• \`${m}\` — ${d.split(": ")[1]}`).join("\n")}`;
    const { text, buttons } = helpReply({ sections, topic: ctx.args?.[0], intro, cmd: ctx.cmd });
    return reply(text, { ephemeral: true, buttons });
  },
};

export const COMMANDS = {
  help,
  ...SETUP_COMMANDS,
  ...WALLET_COMMANDS,
  ...DAO_COMMANDS,
  ...PROPOSING_COMMANDS,
  ...DECIDING_COMMANDS,
  ...COUNCIL_COMMANDS,
  ...MARKET_COMMANDS,
};

/** Creating or (re)linking decides what the whole chat runs, so only admins may. */
export const ADMIN_COMMANDS = new Set(["createdao", "link", "unlink"]);

/** Contract errors any command can hit, in words. Commands explain their own. */
const CHAIN_ERRORS = {
  ERR_NO_PROPOSAL: "There's no such proposal.",
  ERR_KIND_LOCKS_CORE: "That proposal would lock the DAO, so the orbit refuses it.",
  ERR_STORAGE: "Your staking storage ran out; staking again tops it up.",
  ERR_NOT_ENOUGH_GAS: "The network needed more gas; try again.",
};

/** Runs one command and always returns a reply, never throws. Errors are private. */
export async function runCommand(name, ctx) {
  const command = COMMANDS[name];
  if (!command) return reply(`Unknown command \`${name}\`. Try \`${ctx.cmd("help")}\`.`, { ephemeral: true });
  if (ADMIN_COMMANDS.has(name) && !ctx.isDirect && ctx.isAdmin !== true) {
    return reply(ctx.isAdmin === undefined ? "Couldn't confirm you're an admin here - try again in a moment." : "Only this chat's admins can create or link its DAO.", { ephemeral: true });
  }
  try {
    const result = await command.run({ ...ctx, command: name });
    return { ...result, ephemeral: result.ephemeral ?? Boolean(command.ephemeralByDefault) };
  } catch (err) {
    if (err instanceof UserError) return reply(err.message, { ephemeral: true });
    if (err instanceof ChainError && CHAIN_ERRORS[err.code]) return reply(CHAIN_ERRORS[err.code], { ephemeral: true });
    console.error(`[${ctx.platform}] ${name} failed:`, err);
    return reply(`Couldn't complete \`${name}\`: ${err.message || "unknown error"}`, { ephemeral: true });
  }
}
