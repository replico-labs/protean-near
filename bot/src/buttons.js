/**
 * Buttons under proposal messages and notices, the same on Telegram and Discord.
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

const b = (label, cmd) => ({ label, cmd });

/**
 * Where a Sowellian proposal is once it executed, from its bet (get_bet):
 * Measuring, Resolvable (measuring is over, nobody proposed an outcome),
 * ResolutionProposed (open to dispute), ResolutionFinal (undisputed, can be
 * locked in), Adjudicating, AdjudicationOver, or Resolved. `now` in ns.
 */
export function betPhase(bet, now) {
  if (!bet) return null;
  if (bet.outcome) return "Resolved";
  if (bet.challenger) return now < BigInt(bet.adjudication_end ?? 0) ? "Adjudicating" : "AdjudicationOver";
  if (bet.resolver) return now < BigInt(bet.challenge_deadline ?? 0) ? "ResolutionProposed" : "ResolutionFinal";
  if (!bet.measurement_deadline || now < BigInt(bet.measurement_deadline)) return "Measuring";
  return "Resolvable";
}

/** A decision-markets proposal's markets (get_exchange): Unseeded, Trading or TradingOver. */
export function marketPhase(exchange, now) {
  if (!exchange) return null;
  if (!exchange.opened_at) return "Unseeded";
  return now < BigInt(exchange.deadline) ? "Trading" : "TradingOver";
}

/** Sowellian: approval vote, then positions, then the resolution of its outcome. */
function sowellianRows(id, state, bet, phase) {
  if (state === "Active") return [voteRow(id)];
  if (state === "Positions") return [[b("🟢 Back YES", `ask amount position ${id} yes`), b("🔴 Back NO", `ask amount position ${id} no`)]];
  if (state !== "Executed") return [];
  switch (phase) {
    case "Resolvable":
      // An oracle reads the outcome itself; otherwise someone proposes it, with a bond.
      return bet.criteria?.Oracle
        ? [[b("🔮 Resolve from the oracle", `finalizeresolution ${id}`)]]
        : [[b("📣 It worked", `ask sure proposeresolution ${id} success`), b("📣 It didn't", `ask sure proposeresolution ${id} failure`)]];
    case "ResolutionProposed":
      return [[b("⚔️ Dispute", `ask sure dispute ${id}`)]];
    case "ResolutionFinal":
      return [[b("✅ Lock it in", `finalizeresolution ${id}`)]];
    case "Adjudicating":
      return [[b("✅ It worked", `adjudicate ${id} success`), b("❌ It didn't", `adjudicate ${id} failure`)]];
    case "AdjudicationOver":
      return [[b("🔒 Close the vote", `finalizeresolution ${id}`)]];
    case "Resolved":
      return [[b("💰 Claim winnings", `claimposition ${id}`)]];
    default:
      return [];
  }
}

/**
 * Decision markets: buying the token with NEAR in a market raises its price
 * there, so "Buy pass" backs the proposal and "Buy fail" bets against it.
 * Each asks how much first. Once trading ends, winners redeem.
 */
function marketRows(id, phase) {
  if (phase === "Trading") {
    return [
      [b("🟢 Buy pass", `ask amount trade ${id} pass near`), b("🔴 Buy fail", `ask amount trade ${id} fail near`)],
      [b("Sell pass", `ask amount trade ${id} pass token`), b("Sell fail", `ask amount trade ${id} fail token`)],
      [b("➗ Split NEAR", `ask amount split ${id} near`), b("➗ Split tokens", `ask amount split ${id} token`)],
    ];
  }
  return phase === "TradingOver" ? [[b("💰 Redeem", `redeem ${id}`)]] : [];
}

/**
 * What a member can do with proposal `id` of a `model` DAO in `state`: an
 * orbit state (Active, ChallengeWindow, Succeeded, Queued...) or, for a
 * board, the core's status (InProgress...). `page`: its proposal page, if
 * any. `market`: { bet } (Sowellian) or { exchange } (decision markets),
 * with `now`, for the phases those models go through.
 */
export function proposalButtons(model, id, state, page = null, market = {}) {
  const rows = [];
  const now = market.now ?? 0n;
  if (model === "board") {
    if (state === "InProgress") rows.push([{ label: "✅ Approve", cmd: `vote ${id} for` }, { label: "❌ Reject", cmd: `vote ${id} against` }]);
  } else if (model === "conviction") {
    if (state === "Active") rows.push([{ label: "💪 Support", cmd: `support ${id}` }, { label: "⏳ Queue", cmd: `queue ${id}` }]);
  } else if (model === "sowellian") {
    rows.push(...sowellianRows(id, state, market.bet, betPhase(market.bet, now)));
  } else if (model === "decisionMarkets") {
    rows.push(...marketRows(id, marketPhase(market.exchange, now)));
  } else if (state === "ChallengeWindow") {
    rows.push([{ label: "⚔️ Challenge", cmd: `challenge ${id}` }]);
  } else if (state === "Active") {
    rows.push(voteRow(id));
  }
  if (state === "Succeeded" || state === "Queued") rows.push([{ label: "▶️ Execute", cmd: `execute ${id}` }]);
  rows.push([{ label: "🔄 Status", cmd: `proposal ${id}` }, ...(page ? [{ label: "📄 Details", url: page }] : [])]);
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
  if (!words.every((w) => /^[a-z0-9.]+$/i.test(w))) return null;
  return [name, words];
}

/** Only these commands can come from a button: a forged payload can't run anything else. */
export const BUTTON_COMMANDS = new Set([
  "vote", "execute", "proposal", "support", "queue", "challenge", "help",
  // Sowellian
  "position", "proposeresolution", "dispute", "adjudicate", "finalizeresolution", "claimposition",
  // Decision markets
  "split", "trade", "redeem",
  // A second step (buttonMenus.js): how much, or "are you sure".
  "ask",
]);

/** Telegram's inline keyboard for `rows`. */
export function telegramKeyboard(rows = []) {
  return {
    inline_keyboard: rows.map((row) => row.map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: encodeButton(b.cmd) }))),
  };
}
