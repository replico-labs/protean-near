import { services } from "./services.js";
import { proposalButtons } from "../buttons.js";
import { readable } from "../near/evm.js";
import { executionPeriodNs } from "../near/models.js";
import { formatTime, nowNs } from "./helpers.js";

/**
 * Posts in each linked chat when its proposals move on their own, with
 * nobody typing a command: voting ended, a passed proposal can now be
 * executed, its execution window is about to close, or it expired.
 *
 * Each chat's link remembers the last stage seen of its latest proposals
 * (`watch`), so a restart doesn't repeat old news. The first look at a
 * chat, or at a new orbit after a model switch, only records stages.
 * Board DAOs are left out: their proposals execute when approved.
 */

const SCAN = 15;
const CLOSING_NS = 60n * 60n * 1_000_000_000n;
const VOTING = new Set(["Pending", "Active", "ChallengeWindow", "Positions"]);

/** A proposal's stage: its state, with a passed one split into Waiting (timelock), Ready and Closing (last hour). */
export function stageOf(p, now, period) {
  if (p.state !== "Succeeded" && p.state !== "Queued") return p.state;
  const from = BigInt(p.executable_after ?? 0);
  if (now < from) return "Waiting";
  if (period && now + CLOSING_NS >= from + period) return "Closing";
  return "Ready";
}

/** What to post when proposal `p` moves from stage `prev` to `stage`, or null. */
export function noticeFor(p, prev, stage, period, cmd) {
  const title = `*#${p.id}* — ${readable(p.description)}`;
  const execute = `\`${cmd("execute")} ${p.id}\``;
  if (stage === "Waiting" && VOTING.has(prev)) return `✅ Voting ended: ${title} passed. It can be executed from ${formatTime(p.executable_after)}.`;
  if (stage === "Ready") return VOTING.has(prev) ? `✅ Voting ended: ${title} passed and can be executed now with ${execute}.` : `▶️ ${title} can be executed now with ${execute}.`;
  if (stage === "Closing" && period) return `⏳ ${title} must be executed by ${formatTime(BigInt(p.executable_after ?? 0) + period)} or it expires: ${execute}.`;
  if (stage === "Defeated" && VOTING.has(prev)) return `❌ Voting ended: ${title} was defeated.`;
  if (stage === "Expired" && !VOTING.has(prev)) return `⌛ ${title} expired: nobody executed it in time.`;
  return null;
}

const periods = new Map();
async function periodOf(orbitId) {
  if (!periods.has(orbitId)) {
    const { name, settings } = services.orbit.modelOf(await services.orbit.getModel(orbitId));
    periods.set(orbitId, executionPeriodNs(name, settings));
  }
  return periods.get(orbitId);
}

/** Looks at one chat's latest proposals and posts what changed: `post(chatId, text, buttons)`. */
export async function scanChat(platform, chatId, link, post, cmd, now = nowNs()) {
  if (link.model === "board" || !link.orbitId) return;
  const count = await services.orbit.getProposalCount(link.orbitId);
  const list = count ? await services.orbit.getProposals(link.orbitId, Math.max(0, count - SCAN), SCAN) : [];
  const period = await periodOf(link.orbitId);
  const seen = link.watch?.orbit === link.orbitId ? link.watch.stages : null;
  const stages = {};
  for (const p of list) {
    const stage = stageOf(p, now, period);
    stages[p.id] = stage;
    const prev = seen?.[p.id];
    if (prev === undefined || prev === stage) continue;
    const text = noticeFor(p, prev, stage, period, cmd);
    if (text) await post(chatId, text, proposalButtons(link.model, p.id, p.state));
  }
  if (JSON.stringify(stages) !== JSON.stringify(seen)) {
    const current = services.db.getChatDao(platform, chatId);
    if (current?.orbitId === link.orbitId) services.db.setChatDao(platform, chatId, { ...current, watch: { orbit: link.orbitId, stages } });
  }
}

/**
 * Scans every chat linked on `platform` every NOTIFY_SECONDS (default 60;
 * 0 turns notifications off). Returns a function that stops it.
 */
export function startNotifier(platform, post, cmd) {
  const seconds = Number(process.env.NOTIFY_SECONDS ?? 60);
  if (!seconds) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const [chatId, link] of services.db.chatsOn(platform)) {
        await scanChat(platform, chatId, link, post, cmd).catch((err) => console.error(`[${platform}] Notifications for ${chatId} failed:`, err.message ?? err));
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, seconds * 1000);
  tick();
  return () => clearInterval(timer);
}
