// First: blanks tokens and keys in everything logged after this.
import "../logRedaction.js";
import { Bot, GrammyError } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { COMMANDS, ADMIN_COMMANDS, runCommand } from "./commands.js";
import { decodeButton, BUTTON_COMMANDS, telegramKeyboard } from "../buttons.js";

/**
 * Telegram front-end for the shared commands (commands.js).
 *
 * One group links to one DAO; accounts are keyed ("telegram", user ID).
 * Updates run concurrently (on-chain calls take seconds), except that one
 * user's commands run in order.
 *
 * Run: `npm run telegram`. Env: TELEGRAM_BOT_TOKEN plus the NEAR, KMS and
 * Supabase settings in .env.example.
 */

const TELEGRAM_MAX_MESSAGE = 4096;
const cmd = (name) => `/${name}`;

/** "/vote@protean_near_bot 3 for" -> ["vote", ["3", "for"]], or null if it isn't a command. */
export function parseCommandText(text) {
  const match = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text?.trim() ?? "");
  if (!match) return null;
  // Backticks come along when an account name is copied from a bot message.
  const args = (match[2] ?? "").replace(/`/g, "").split(/\s+/).filter(Boolean);
  return [match[1].toLowerCase(), args];
}

/** Splits text into Telegram-sized messages at line breaks. */
export function splitForTelegram(text, limit = TELEGRAM_MAX_MESSAGE) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    for (const piece of line.length > limit ? line.match(new RegExp(`[\\s\\S]{1,${limit}}`, "g")) : [line]) {
      if (current && current.length + 1 + piece.length > limit) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

async function isChatAdmin(ctx) {
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return undefined;
  }
}

/**
 * Sends a command's reply. Markdown first; if Telegram can't parse it (a
 * description with a stray * or _), the same text goes as plain text.
 */
async function send(ctx, result) {
  const chunks = splitForTelegram(result.text);
  for (const [i, chunk] of chunks.entries()) {
    const last = i === chunks.length - 1;
    const extra = last && result.buttons?.length ? { reply_markup: telegramKeyboard(result.buttons) } : {};
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown", ...extra });
    } catch (err) {
      if (!(err instanceof GrammyError && /can't parse entities/i.test(err.description))) throw err;
      await ctx.reply(chunk, extra);
    }
  }
}

function commandContext(ctx, args) {
  return {
    platform: "telegram",
    chatId: String(ctx.chat.id),
    userId: String(ctx.from.id),
    args,
    isDirect: ctx.chat.type === "private",
    cmd,
  };
}

export function createTelegramBot(token) {
  const bot = new Bot(token);
  // One user's commands in order; different users in parallel.
  bot.use(sequentialize((ctx) => ctx.from?.id?.toString()));

  bot.on("message:text", async (ctx) => {
    const parsed = parseCommandText(ctx.message.text);
    if (!parsed) return;
    const [name, args] = parsed;
    const command = name === "start" ? "help" : name;
    if (!COMMANDS[command]) return; // another bot's command, in a group
    const commandCtx = commandContext(ctx, args);
    if (ADMIN_COMMANDS.has(command) && !commandCtx.isDirect) commandCtx.isAdmin = await isChatAdmin(ctx);
    await ctx.replyWithChatAction("typing").catch(() => {});
    await send(ctx, await runCommand(command, commandCtx));
  });

  // A button press runs its command as the presser; the result goes to the chat.
  bot.on("callback_query:data", async (ctx) => {
    const decoded = decodeButton(ctx.callbackQuery.data);
    if (!decoded || !BUTTON_COMMANDS.has(decoded[0])) return ctx.answerCallbackQuery();
    const [name, args] = decoded;
    await ctx.answerCallbackQuery({ text: `Running ${cmd(name)} ${args.join(" ")}...` });
    const result = await runCommand(name, commandContext(ctx, args));
    const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    await send(ctx, { ...result, text: `${who} → \`${cmd(name)} ${args.join(" ")}\`\n\n${result.text}` });
  });

  bot.catch((err) => console.error("[telegram] Update failed:", err.error ?? err));
  return bot;
}

export async function startTelegramBot(token) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");
  const bot = createTelegramBot(token);
  await bot.api.setMyCommands(Object.entries(COMMANDS).map(([command, c]) => ({ command, description: c.description.slice(0, 256) })));
  const runner = run(bot);
  console.log(`[telegram] Running as @${(await bot.api.getMe()).username}`);
  return runner;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startTelegramBot(process.env.TELEGRAM_BOT_TOKEN).catch((err) => {
    console.error("[telegram] Fatal error:", err);
    process.exit(1);
  });
}
