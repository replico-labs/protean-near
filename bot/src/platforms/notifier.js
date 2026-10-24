import { services } from "./services.js";
import { proposalButtons, betPhase, marketPhase } from "../buttons.js";
import { marketOf } from "./proposals.js";
import { proposalPageUrl } from "../proposalPages.js";
import { readable } from "../near/evm.js";
import { executionPeriodNs } from "../near/models.js";
import { formatTime, nowNs } from "./helpers.js";

/**
 * Posts in each linked chat when its proposals move on their own, with
 * nobody typing a command: a proposal made elsewhere (another chat, or
 * straight on chain), voting ended, a passed proposal can now be executed,
 * its execution window is about to close, or it expired; and each model's
 * own steps: challenged, positions or markets open, a Sowellian outcome
 * measured, proposed, disputed, resolved. Each notice has the proposal's
 * buttons for that moment.
 *
 * Each chat's link remembers the last stage seen of its latest proposals
 * (`watch`), so a restart doesn't repeat old news. The first look at a
 * chat, or at a new orbit after a model switch, only records stages.
 * Board DAOs are left out: their proposals execute when approved.
 */

const SCAN = 15;
const CLOSING_NS = 60n * 60n * 1_000_000_000n;
const VOTING = new Set(["Pending", "Active", "ChallengeWindow", "Positions", "Unseeded", "Trading"]);
// After a Sowellian proposal executes, its outcome is measured and resolved.
const RESOLVING = new Set(["Measuring", "Resolvable", "ResolutionProposed", "ResolutionFinal", "Adjudicating", "AdjudicationOver"]);

/**
 * A proposal's stage: its state, with a passed one split into Waiting
 * (timelock), Ready and Closing (last hour); a decision-markets vote into
 * Unseeded and Trading; and an executed Sowellian proposal into its
 * resolution phases (betPhase). `market` is from marketOf().
 */
export function stageOf(p, now, period, market = {}) {
  if (p.state === "Active" && market.exchange) return marketPhase(market.exchange, now) === "Unseeded" ? "Unseeded" : "Trading";
  if (p.state === "Executed" && market.bet) return betPhase(market.bet, now);
  if (p.state !== "Succeeded" && p.state !== "Queued") return p.state;
  const from = BigInt(p.executable_after ?? 0);
  if (now < from) return "Waiting";
  if (period && now + CLOSING_NS >= from + period) return "Closing";
  return "Ready";
}

const ended = (model, prev) => (prev === "Positions" ? "Positions closed" : model === "decisionMarkets" || prev === "Trading" ? "Trading ended" : "Voting ended");

/** What to post when proposal `p` moves from stage `prev` to `stage`, or null. `prev` undefined: a new proposal. */
export function noticeFor(p, prev, stage, period, cmd, { model, bet } = {}) {
  const title = `*#${p.id}* — ${readable(p.description)}`;
  const execute = `\`${cmd("execute")} ${p.id}\``;
  if (prev === undefined) return VOTING.has(stage) ? `📝 New proposal: ${title}, by \`${p.proposer}\`.` : null;
  if (stage === "Waiting" && VOTING.has(prev)) return `✅ ${ended(model, prev)}: ${title} passed. It can be executed from ${formatTime(p.executable_after)}.`;
  if (stage === "Ready") return VOTING.has(prev) ? `✅ ${ended(model, prev)}: ${title} passed and can be executed now with ${execute}.` : `▶️ ${title} can be executed now with ${execute}.`;
  if (stage === "Closing" && period) return `⏳ ${title} must be executed by ${formatTime(BigInt(p.executable_after ?? 0) + period)} or it expires: ${execute}.`;
  if (stage === "Defeated" && VOTING.has(prev)) return `❌ ${ended(model, prev)}: ${title} was defeated.`;
  if (stage === "Expired" && !VOTING.has(prev)) return `⌛ ${title} expired: nobody executed it in time.`;
  if (stage === "Positions" && prev === "Active") return `🎲 ${title} was approved. Positions are open: back YES or NO on whether it works.`;
  if (stage === "Active" && prev === "ChallengeWindow") return `⚔️ ${title} was challenged: it goes to a vote.`;
  if (stage === "Trading" && prev === "Unseeded") return `📈 ${title}: its markets are seeded and trading is open.`;
  if (stage === "Resolvable") return `🔍 ${title}: its measurement period is over. ${bet?.criteria?.Oracle ? "Resolve it from the oracle." : "Propose whether it worked."}`;
  if (stage === "ResolutionProposed") return `📣 ${title}: \`${bet.resolver}\` proposed that it was a *${String(bet.proposed_outcome).toLowerCase()}*. It can be disputed until ${formatTime(bet.challenge_deadline)}.`;
  if (stage === "Adjudicating") return `⚔️ ${title}: the proposed outcome was disputed. Stakers vote on it until ${formatTime(bet.adjudication_end)}.`;
  if (stage === "Resolved" && RESOLVING.has(prev)) return `🏁 ${title} resolved: *${String(bet.outcome).toLowerCase()}*. Winning positions can be claimed.`;
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

/** The bet or markets behind a proposal's stage, read only where they can still change. */
async function marketFor(link, p, prev) {
  const sowellian = link.model === "sowellian" && p.state === "Executed" && prev !== "Resolved";
  const markets = link.model === "decisionMarkets" && p.state === "Active";
  return sowellian || markets ? marketOf(link, p.id) : {};
}

/** Looks at one chat's latest proposals and posts what changed: `post(chatId, text, buttons)`. */
export async function scanChat(platform, chatId, link, post, cmd, now = nowNs()) {
  if (link.model === "board" || !link.orbitId) return;
  const count = await services.orbit.getProposalCount(link.orbitId);
  const list = count ? await services.orbit.getProposals(link.orbitId, Math.max(0, count - SCAN), SCAN) : [];
  const period = await periodOf(link.orbitId);
  const seen = link.watch?.orbit === link.orbitId ? link.watch.stages : null;
  // The newest proposal the last scan saw: anything above it is new.
  const top = link.watch?.orbit === link.orbitId ? (link.watch.top ?? Math.max(-1, ...Object.keys(seen).map(Number))) : -1;
  const stages = {};
  for (const p of list) {
    const prev = seen?.[p.id];
    const market = { ...(await marketFor(link, p, prev)), now };
    const stage = stageOf(p, now, period, market);
    stages[p.id] = stage;
    // Nothing on the first look; after that, older proposals the scan just reached aren't new.
    if (!seen || prev === stage || (prev === undefined && p.id <= top)) continue;
    const text = noticeFor(p, prev, stage, period, cmd, { model: link.model, bet: market.bet });
    if (text) await post(chatId, text, proposalButtons(link.model, p.id, p.state, proposalPageUrl(link, p.id), market));
  }
  if (JSON.stringify(stages) !== JSON.stringify(seen) || (list.length && list.at(-1).id !== top)) {
    const current = services.db.getChatDao(platform, chatId);
    if (current?.orbitId === link.orbitId) {
      // Kept: what markAnnounced() recorded meanwhile; dropped: what's older than the scan.
      const oldest = list.length ? list[0].id : 0;
      const earlier = current.watch?.orbit === link.orbitId ? current.watch.stages : {};
      const kept = Object.fromEntries(Object.entries({ ...earlier, ...stages }).filter(([id]) => Number(id) >= oldest));
      services.db.setChatDao(platform, chatId, { ...current, watch: { orbit: link.orbitId, stages: kept, top: list.length ? list.at(-1).id : -1 } });
    }
  }
}

/**
 * A proposal this chat just made: recorded as seen, so the chat isn't told
 * about it again. Other chats linked to the DAO still are.
 */
export function markAnnounced(platform, chatId, id, state) {
  const current = services.db.getChatDao(platform, chatId);
  if (!current?.orbitId || current.watch?.orbit !== current.orbitId) return;
  services.db.setChatDao(platform, chatId, { ...current, watch: { ...current.watch, stages: { ...current.watch.stages, [id]: state } } });
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
      const now = await services.clock.now().catch(() => nowNs());
      for (const [chatId, link] of services.db.chatsOn(platform)) {
        await scanChat(platform, chatId, link, post, cmd, now).catch((err) => console.error(`[${platform}] Notifications for ${chatId} failed:`, err.message ?? err));
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, seconds * 1000);
  tick();
  return () => clearInterval(timer);
}
