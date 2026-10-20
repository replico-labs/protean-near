/**
 * Buttons under proposal messages, the same on Telegram and Discord.
 *
 * A button is a command run as whoever presses it ("vote 3 for"), so it goes
 * through exactly the checks the typed command does, with the presser's own
 * account. Rows are { label, cmd } (runs a command) or { label, url }.
 */

/** What a member can do with a proposal in orbit status `status`. */
export function proposalButtons(id, status = "InProgress") {
  const rows = [];
  if (status === "InProgress") {
    rows.push([
      { label: "✅ For", cmd: `vote ${id} for` },
      { label: "❌ Against", cmd: `vote ${id} against` },
    ]);
  }
  if (status === "Passed") rows.push([{ label: "▶️ Execute", cmd: `execute ${id}` }]);
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
export const BUTTON_COMMANDS = new Set(["vote", "execute", "proposal", "help"]);

/** Telegram's inline keyboard for `rows`. */
export function telegramKeyboard(rows = []) {
  return {
    inline_keyboard: rows.map((row) => row.map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: encodeButton(b.cmd) }))),
  };
}
