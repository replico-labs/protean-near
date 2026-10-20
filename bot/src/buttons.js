/**
 * Buttons under proposal messages, the same on Telegram and Discord.
 *
 * A button is a command run as whoever presses it ("vote 3 for"), so it goes
 * through exactly the checks the typed command does, with the presser's own
 * account. Rows are { label, cmd } (runs a command) or { label, url }.
 */

const voteRow = (id) => [
  { label: "✅ For", cmd: `vote ${id} for` },
  { label: "❌ Against", cmd: `vote ${id} against` },
  { label: "➖ Abstain", cmd: `vote ${id} abstain` },
];

/**
 * What a member can do with proposal `id` of a `model` DAO in `state`: an
 * orbit state (Active, ChallengeWindow, Succeeded, Queued...) or, for a
 * board, the core's status (InProgress...).
 */
export function proposalButtons(model, id, state) {
  const rows = [];
  if (model === "board") {
    if (state === "InProgress") rows.push([{ label: "✅ Approve", cmd: `vote ${id} for` }, { label: "❌ Reject", cmd: `vote ${id} against` }]);
  } else if (model === "conviction") {
    if (state === "Active") rows.push([{ label: "💪 Support", cmd: `support ${id}` }, { label: "⏳ Queue", cmd: `queue ${id}` }]);
  } else if (model === "decisionMarkets") {
    // Trading takes amounts: typed commands only.
  } else if (state === "ChallengeWindow") {
    rows.push([{ label: "⚔️ Challenge", cmd: `challenge ${id}` }]);
  } else if (state === "Active") {
    rows.push(voteRow(id));
  }
  if (state === "Succeeded" || state === "Queued") rows.push([{ label: "▶️ Execute", cmd: `execute ${id}` }]);
  rows.push([{ label: "🔄 Status", cmd: `proposal ${id}` }]);
  return rows;
}

// Button payloads: "c:" + the command line. Telegram allows 64 bytes.
const PREFIX = "c:";

export function encodeButton(cmd) {
  const data = PREFIX + cmd;
  if (Buffer.byteLength(data) > 64) throw new Error(`Button command too long: ${cmd}`);
  return data;
}

/** A pressed button's command as [name, args], or null if it isn't one of ours. */
export function decodeButton(data) {
  if (typeof data !== "string" || !data.startsWith(PREFIX)) return null;
  const words = data.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
  const name = words.shift()?.toLowerCase();
  if (!name || !/^[a-z]+$/.test(name)) return null;
  if (!words.every((w) => /^[a-z0-9]+$/i.test(w))) return null;
  return [name, words];
}

/** Only these commands can come from a button: a forged payload can't run anything else. */
export const BUTTON_COMMANDS = new Set(["vote", "execute", "proposal", "support", "queue", "challenge", "help"]);

/** Telegram's inline keyboard for `rows`. */
export function telegramKeyboard(rows = []) {
  return {
    inline_keyboard: rows.map((row) => row.map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: encodeButton(b.cmd) }))),
  };
}
