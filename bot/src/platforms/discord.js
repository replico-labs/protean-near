// First: blanks tokens and keys in everything logged after this.
import "../logRedaction.js";
import { Client, Events, GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { COMMANDS, ADMIN_COMMANDS, runCommand } from "./commands.js";
import { encodeButton, decodeButton, BUTTON_COMMANDS } from "../buttons.js";

/**
 * Discord front-end for the shared commands (commands.js).
 *
 * Every command is a slash command with typed options built from the
 * command's own option list. One channel links to one DAO; accounts are
 * keyed ("discord", user ID). Replies are deferred at once, since on-chain
 * actions take longer than Discord's 3-second window.
 *
 * Run: `npm run discord`. Env: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID,
 * optional DISCORD_GUILD_ID (registers commands to one server instantly;
 * without it they register globally, which can take an hour), plus the
 * NEAR, KMS and Supabase settings in .env.example.
 */

const DISCORD_MAX_MESSAGE = 2000;
const cmd = (name) => `/${name}`;

/** Telegram-style *bold* -> Discord **bold**, leaving `code` spans alone. */
export function toDiscordMarkdown(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") ? part : part.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1**$2**")))
    .join("");
}

/** Splits text into Discord-sized messages at line breaks. */
export function splitForDiscord(text, limit = DISCORD_MAX_MESSAGE) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    for (const piece of line.length > limit ? line.match(new RegExp(`.{1,${limit}}`, "g")) : [line]) {
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

/** The slash-command definitions Discord's API expects. */
export function buildSlashCommands() {
  return Object.entries(COMMANDS).map(([name, command]) => {
    const builder = new SlashCommandBuilder().setName(name).setDescription(command.description.slice(0, 100)).setDMPermission(false);
    if (ADMIN_COMMANDS.has(name)) builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
    // Discord requires every required option before any optional one.
    const ordered = [...command.options].sort((a, b) => Number(b.required) - Number(a.required));
    for (const opt of ordered) {
      const configure = (o) => {
        o.setName(opt.name).setDescription(opt.description.slice(0, 100)).setRequired(Boolean(opt.required));
        if (opt.choices) o.addChoices(...opt.choices.slice(0, 25).map((c) => ({ name: c, value: c })));
        return o;
      };
      if (opt.type === "integer") builder.addIntegerOption((o) => configure(o).setMinValue(0));
      else builder.addStringOption(configure);
    }
    return builder.toJSON();
  });
}

/**
 * An interaction's options as the commands' positional args, in declared
 * order. A `rest` option is split into words, as if typed.
 */
export function argsFromOptions(command, getOption) {
  const args = [];
  for (const opt of command.options) {
    const value = getOption(opt.name);
    if (value === null || value === undefined || value === "") continue;
    const text = String(value).replace(/`/g, "").trim();
    if (!text) continue;
    if (opt.rest) args.push(...text.split(/\s+/).filter(Boolean));
    else args.push(text);
  }
  return args;
}

/** A reply's buttons as Discord action rows (at most 5 rows of 5). */
export function discordComponents(rows = []) {
  return rows.slice(0, 5).map((row) =>
    new ActionRowBuilder().addComponents(
      row.slice(0, 5).map((b) =>
        b.url ? new ButtonBuilder().setLabel(b.label).setStyle(ButtonStyle.Link).setURL(b.url) : new ButtonBuilder().setLabel(b.label).setStyle(ButtonStyle.Secondary).setCustomId(encodeButton(b.cmd))
      )
    )
  );
}

function commandContext(interaction, args) {
  return {
    platform: "discord",
    chatId: interaction.channelId,
    userId: interaction.user.id,
    args,
    isAdmin: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    cmd,
  };
}

/** A button press: runs its command as the presser and posts the result in the channel (errors only to them). */
async function handleButton(interaction) {
  const decoded = decodeButton(interaction.customId);
  if (!decoded || !BUTTON_COMMANDS.has(decoded[0])) return;
  const [name, args] = decoded;
  if (name === "help") {
    const result = await runCommand(name, commandContext(interaction, args));
    const [first] = splitForDiscord(toDiscordMarkdown(result.text));
    await interaction.update({ content: first, components: discordComponents(result.buttons) });
    return;
  }
  await interaction.deferReply();
  const result = await runCommand(name, commandContext(interaction, args));
  const [first, ...more] = splitForDiscord(toDiscordMarkdown(`<@${interaction.user.id}> → \`${cmd(name)} ${args.join(" ")}\`\n\n${result.text}`));
  if (result.ephemeral) {
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({ content: first, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.editReply({ content: first, components: discordComponents(result.buttons) });
  for (const content of more) await interaction.followUp({ content });
}

/** Handles one slash-command or button interaction. */
export async function handleInteraction(interaction) {
  if (interaction.isButton?.()) return handleButton(interaction);
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  const command = COMMANDS[name];
  if (!command) return;

  await interaction.deferReply(command.ephemeralByDefault ? { flags: MessageFlags.Ephemeral } : {});
  const result = await runCommand(name, commandContext(interaction, argsFromOptions(command, (n) => interaction.options.get(n)?.value)));
  const [first, ...more] = splitForDiscord(toDiscordMarkdown(result.text));
  const privateFlags = { flags: MessageFlags.Ephemeral };

  // A deferred public reply can't become private afterwards, so private
  // results (errors) go in a private follow-up and the placeholder is removed.
  if (result.ephemeral && !command.ephemeralByDefault) {
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({ content: first, ...privateFlags });
  } else {
    await interaction.editReply({ content: first, ...(more.length === 0 ? { components: discordComponents(result.buttons) } : {}) });
  }
  const isPrivate = Boolean(result.ephemeral || command.ephemeralByDefault);
  for (const content of more) await interaction.followUp({ content, ...(isPrivate ? privateFlags : {}) });
}

export async function startDiscordBot({ token, applicationId, guildId } = {}) {
  if (!token || !applicationId) throw new Error("DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required.");
  const body = buildSlashCommands();
  const route = guildId ? Routes.applicationGuildCommands(applicationId, guildId) : Routes.applicationCommands(applicationId);
  await new REST({ version: "10" }).setToken(token).put(route, { body });
  console.log(`[discord] Registered ${body.length} slash commands ${guildId ? `to guild ${guildId}` : "globally"}`);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction).catch((err) => console.error("[discord] Interaction failed:", err));
  });
  client.once(Events.ClientReady, (c) => console.log(`[discord] Logged in as ${c.user.tag}`));
  await client.login(token);
  return client;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDiscordBot({
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    guildId: process.env.DISCORD_GUILD_ID,
  }).catch((err) => {
    console.error("[discord] Fatal error:", err);
    process.exit(1);
  });
}
