// First: blanks tokens and keys in everything logged after this.
import "../logRedaction.js";
import { Bot, GrammyError } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { COMMANDS, ADMIN_COMMANDS, runCommand, runButton, commandsFor } from "./commands.js";
import { services } from "./services.js";
import { decodeButton, BUTTON_COMMANDS, telegramKeyboard } from "../buttons.js";
import { startNotifier } from "./notifier.js";
import { editLinkFromStart } from "../proposalPages.js";

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

/** Telegram's command menu for `model`'s commands (null: a chat with no DAO yet). */
export function menuFor(model) {
  return commandsFor(model).map(([command, c]) => ({ command, description: c.description.slice(0, 256) }));
}

/**
 * Sets the "/" menu in chat `chatId` to the commands of the DAO it's linked
 * to, so members see only what applies; with no link the chat falls back to
 * the bot's default menu (setup and wallet commands).
 */
export async function syncChatMenu(api, chatId, link) {
  const scope = { type: "chat", chat_id: chatId };
  try {
    if (link) await api.setMyCommands(menuFor(link.model), { scope });
    else await api.deleteMyCommands({ scope });
  } catch (err) {
    // The bot may have left the chat; the menu is a convenience, never a blocker.
    console.error(`[telegram] Couldn't update the command menu in ${chatId}:`, err.description ?? err.message);
  }
}

/** Runs a command, then updates the chat's menu if the command changed what the chat runs. */
async function runAndSyncMenu(ctx, name, commandCtx) {
  const before = services.db.getChatDao("telegram", commandCtx.chatId);
  const result = await runCommand(name, commandCtx);
  const after = services.db.getChatDao("telegram", commandCtx.chatId);
  if (before?.model !== after?.model || before?.daoId !== after?.daoId) await syncChatMenu(ctx.api, ctx.chat.id, after);
  return result;
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
  await sendText(ctx, result);
  if (result.private) await sendPrivately(ctx, result.private);
}

async function sendText(ctx, result) {
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

/**
 * A reply only the user may see (a proposal's edit link), in a DM. A bot
 * can't message someone who never started it, so then the group gets a
 * link that opens the DM and sends it there (/start <start>).
 */
async function sendPrivately(ctx, { text, start }) {
  try {
    await postToChat(ctx.api, ctx.from.id, text);
  } catch (err) {
    if (!(err instanceof GrammyError)) throw err;
    const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    await sendText(ctx, { text: `${who}, I can't message you first: [open a chat with me](https://t.me/${ctx.me.username}?start=${start}) and I'll send your private link there.` });
  }
}

function commandContext(ctx, args) {
  return {
    platform: "telegram",
    chatId: String(ctx.chat.id),
    userId: String(ctx.from.id),
    args,
    isDirect: ctx.chat.type === "private",
    replyTo: repliedTo(ctx.message),
    cmd,
  };
}

/**
 * The person whose message a command replies to (/tip 100 as a reply tips
 * them), or null. In a forum topic every message "replies" to the topic's
 * first message, which isn't a reply to anyone; bots have no accounts.
 */
export function repliedTo(message) {
  const replied = message?.reply_to_message;
  if (!replied?.from || replied.from.is_bot || replied.forum_topic_created) return null;
  if (message.is_topic_message && replied.message_id === message.message_thread_id) return null;
  return { userId: String(replied.from.id), name: replied.from.first_name || replied.from.username || "them" };
}

export function createTelegramBot(token) {
  const bot = new Bot(token);
  // One user's commands in order; different users in parallel.
  bot.use(sequentialize((ctx) => ctx.from?.id?.toString()));

  bot.on("message:text", async (ctx) => {
    const parsed = parseCommandText(ctx.message.text);
    if (!parsed) return;
    const [name, args] = parsed;
    // A proposer opening the DM from the group's link gets their edit link.
    if (name === "start" && ctx.chat.type === "private" && args[0]?.startsWith("pe_")) {
      const text = await editLinkFromStart(args[0], commandContext(ctx, []));
      if (text) return sendText(ctx, { text });
    }
    const command = name === "start" ? "help" : name;
    if (!COMMANDS[command]) return; // another bot's command, in a group
    const commandCtx = commandContext(ctx, args);
    if (ADMIN_COMMANDS.has(command) && !commandCtx.isDirect) commandCtx.isAdmin = await isChatAdmin(ctx);
    await ctx.replyWithChatAction("typing").catch(() => {});
    await send(ctx, await runAndSyncMenu(ctx, command, commandCtx));
  });

  // A button press runs its command as the presser; the result goes to the chat.
  bot.on("callback_query:data", async (ctx) => {
    const decoded = decodeButton(ctx.callbackQuery.data);
    if (!decoded || !BUTTON_COMMANDS.has(decoded[0])) return ctx.answerCallbackQuery();
    const [name, args] = decoded;
    const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    // A second step (how much? are you sure?): a group bot can't show one member a
    // message, so it's posted addressed to the presser.
    if (name === "ask") {
      await ctx.answerCallbackQuery();
      const menu = await runButton(name, commandContext(ctx, args));
      return send(ctx, { ...menu, text: `${who}, ${menu.text}` });
    }
    await ctx.answerCallbackQuery({ text: `Running ${cmd(name)} ${args.join(" ")}...` });
    const result = await runAndSyncMenu(ctx, name, commandContext(ctx, args));
    await send(ctx, { ...result, text: `${who} → \`${cmd(name)} ${args.join(" ")}\`\n\n${result.text}` });
  });

  bot.catch((err) => console.error("[telegram] Update failed:", err.error ?? err));
  return bot;
}

/** A message the bot posts on its own (notifications), Markdown first as in send(). */
async function postToChat(api, chatId, text, buttons) {
  const extra = buttons?.length ? { reply_markup: telegramKeyboard(buttons) } : {};
  try {
    await api.sendMessage(chatId, text, { parse_mode: "Markdown", ...extra });
  } catch (err) {
    if (!(err instanceof GrammyError && /can't parse entities/i.test(err.description))) throw err;
    await api.sendMessage(chatId, text, extra);
  }
}

/**
 * Polls Telegram, starting again after a 409 Conflict: another copy is
 * polling the same token, as for a few seconds during a host's deploy (the
 * new copy starts before the old one stops). grammY's runner stops on a
 * 409 instead of retrying. Any other polling failure ends the process, so
 * the host restarts it. Returns the runner's isRunning() and stop().
 */
export function keepPolling(bot, { runner: start = run, retryMs = 5000 } = {}) {
  let handle;
  let stopping = false;
  const poll = () => {
    handle = start(bot);
    handle.task()?.catch((err) => {
      if (stopping) return;
      if (err?.error_code === 409) {
        console.warn(`[telegram] Another copy is polling this bot token (409 Conflict); trying again in ${retryMs / 1000} s.`);
        setTimeout(() => stopping || poll(), retryMs);
        return;
      }
      console.error("[telegram] Polling stopped:", err);
      process.exit(1);
    });
  };
  poll();
  return {
    isRunning: () => handle.isRunning(),
    stop: () => {
      stopping = true;
      return handle.stop();
    },
  };
}

export async function startTelegramBot(token) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");
  const bot = createTelegramBot(token);
  // Default menu: what any chat can do before it has a DAO. Linked chats get their model's commands.
  await bot.api.setMyCommands(menuFor(null));
  for (const [chatId, link] of services.db.chatsOn("telegram")) await syncChatMenu(bot.api, chatId, link);
  const runner = keepPolling(bot);
  console.log(`[telegram] Running as @${(await bot.api.getMe()).username}`);
  startNotifier("telegram", (chatId, text, buttons) => postToChat(bot.api, chatId, text, buttons), cmd);
  return runner;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startTelegramBot(process.env.TELEGRAM_BOT_TOKEN).catch((err) => {
    console.error("[telegram] Fatal error:", err);
    process.exit(1);
  });
}
