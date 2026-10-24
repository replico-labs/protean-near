import { helpReply } from "../helpMenu.js";
import { MODELS } from "../near/models.js";
import { ChainError } from "../near/client.js";
import { services } from "./services.js";
import { UserError, reply } from "./helpers.js";
import { buttonMenu } from "./buttonMenus.js";
import { SETUP_COMMANDS } from "./commands/setup.js";
import { WALLET_COMMANDS } from "./commands/wallet.js";
import { DAO_COMMANDS } from "./commands/dao.js";
import { PROPOSING_COMMANDS } from "./commands/proposing.js";
import { DECIDING_COMMANDS } from "./commands/deciding.js";
import { COUNCIL_COMMANDS } from "./commands/council.js";
import { MARKET_COMMANDS } from "./commands/markets.js";
import { TREASURY_COMMANDS } from "./commands/treasury.js";
import { INTENTS_COMMANDS } from "./commands/intents.js";
import { EVM_COMMANDS } from "./commands/evm.js";
import { HYPERLIQUID_COMMANDS } from "./commands/hyperliquid.js";

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
 * buttons?, private? }. `private` ({ text, start }) goes only to whoever
 * ran the command: a DM on Telegram (or, if the bot can't message them
 * first, a link that opens one: /start <start>), a hidden reply on Discord. `options` drives Discord's slash commands; `section`, `usage`,
 * `models` (the models a command applies to) and `needsDao` drive help and
 * Telegram's command menu.
 */

// Help sections, in order, and the topic word for each.
const SECTIONS = { Setup: "setup", "Your wallet": "wallet", "The DAO": "dao", Proposing: "proposing", Treasury: "treasury", Deciding: "deciding", Council: "council", Markets: "markets" };

const help = {
  section: "Help",
  usage: "[topic]",
  description: "The commands for this chat's DAO, by topic",
  ephemeralByDefault: true,
  options: [{ name: "topic", description: "One topic, or all", required: false, choices: [...Object.values(SECTIONS), "all"] }],
  async run(ctx) {
    const dao = services.db.getChatDao(ctx.platform, ctx.chatId);
    const available = commandsFor(dao?.model ?? null);
    const sections = Object.entries(SECTIONS).map(([title, key]) => ({
      key,
      title,
      lines: available
        .filter(([, c]) => c.section === title)
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
  ...TREASURY_COMMANDS,
  ...INTENTS_COMMANDS,
  ...EVM_COMMANDS,
  ...HYPERLIQUID_COMMANDS,
  ...DECIDING_COMMANDS,
  ...COUNCIL_COMMANDS,
  ...MARKET_COMMANDS,
};

/**
 * The commands that apply in a chat whose DAO runs `model`, or with no DAO
 * yet (null), as [name, command]: the same filter /help uses. `models`
 * limits a command to some models; `needsDao` to chats that have a DAO.
 */
export function commandsFor(model) {
  return Object.entries(COMMANDS).filter(([, c]) => (c.models ? model && c.models.includes(model) : model || !c.needsDao));
}

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

/**
 * A pressed button: its command, or for `ask` a second-step menu
 * (buttonMenus.js) meant only for the presser ({ menu: true, ephemeral }).
 */
export async function runButton(name, ctx) {
  if (name !== "ask") return runCommand(name, ctx);
  try {
    return reply("", { ...(await buttonMenu(ctx, ctx.args)), menu: true, ephemeral: true });
  } catch (err) {
    if (!(err instanceof UserError)) console.error("[buttons] ask failed:", err);
    return reply(err instanceof UserError ? err.message : "Couldn't open that menu. Try again in a moment.", { ephemeral: true });
  }
}
