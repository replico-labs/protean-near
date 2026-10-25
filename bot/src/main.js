// First: blanks tokens and keys in everything logged after this.
import "./logRedaction.js";
import { startTelegramBot } from "./platforms/telegram.js";
import { startDiscordBot } from "./platforms/discord.js";
import { proposalPagesConfigured, startProposalApi } from "./proposalPages.js";

/**
 * The bot as one process, for hosting: Telegram when TELEGRAM_BOT_TOKEN is
 * set, Discord when DISCORD_BOT_TOKEN is, both sharing the chat links.
 * `npm start`. On SIGTERM (a redeploy) it stops taking updates first.
 */

const running = [];
if (process.env.TELEGRAM_BOT_TOKEN) running.push(["telegram", await startTelegramBot(process.env.TELEGRAM_BOT_TOKEN)]);
if (process.env.DISCORD_BOT_TOKEN) {
  running.push([
    "discord",
    await startDiscordBot({ token: process.env.DISCORD_BOT_TOKEN, applicationId: process.env.DISCORD_APPLICATION_ID, guildId: process.env.DISCORD_GUILD_ID }),
  ]);
}
if (!running.length) {
  console.error("Set TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, or both.");
  process.exit(1);
}
// Proposal pages: the website reads and saves them through this API. A host
// that sets PORT (Render) also checks GET /health there, pages or not.
if (proposalPagesConfigured() || process.env.PORT) running.push(["http", await startProposalApi(Number(process.env.PORT || 3000))]);

async function shutdown(signal) {
  console.log(`${signal}: stopping`);
  for (const [platform, handle] of running) {
    const stop = { telegram: () => handle.isRunning() && handle.stop(), discord: () => handle.destroy(), http: () => handle.close() }[platform];
    await Promise.resolve().then(stop).catch(() => {});
  }
  process.exit(0);
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
