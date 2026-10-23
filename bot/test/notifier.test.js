import { test } from "node:test";
import assert from "node:assert/strict";
import { services } from "../src/platforms/services.js";
import { scanChat } from "../src/platforms/notifier.js";

const MIN = 60n * 1_000_000_000n;
const ORBIT = "tw.ark.orbits.testnet";
const cmd = (n) => `/${n}`;

/** A chat linked to a token-weighted orbit whose proposals are `proposals`, and what the bot posted. */
function setup(proposals) {
  const links = { "telegram:-100": { daoId: "ark.sputnikv2.testnet", orbitId: ORBIT, model: "tokenWeighted", tokenId: "token.ark", stakingId: "staking.ark" } };
  const posted = [];
  Object.assign(services, {
    orbit: {
      ...services.orbit,
      getProposalCount: async () => proposals.length,
      getProposals: async (o, from, limit) => proposals.slice(from, from + limit),
      getModel: async () => ({ TokenWeighted: { execution_period: String(72n * 60n * MIN) } }),
    },
    db: {
      getChatDao: (p, c) => links[`${p}:${c}`] ?? null,
      setChatDao: (p, c, l) => (links[`${p}:${c}`] = l),
    },
  });
  const scan = (now) => scanChat("telegram", "-100", links["telegram:-100"], (chatId, text, buttons) => posted.push({ chatId, text, buttons }), cmd, now);
  return { links, posted, scan };
}

const proposal = (id, state, extra = {}) => ({ id, description: `payout ${id}`, state, executable_after: null, ...extra });

test("notifications: the first look records quietly; then voting ending, executing and expiring are each posted once", async () => {
  const p0 = proposal(0, "Active");
  const p1 = proposal(1, "Active");
  const { posted, scan } = setup([p0, p1]);
  await scan(0n);
  assert.equal(posted.length, 0, "nothing on the first look");

  // Voting ends: #0 passed with a timelock, #1 was defeated.
  Object.assign(p0, { state: "Succeeded", executable_after: String(100n * MIN) });
  p1.state = "Defeated";
  await scan(50n * MIN);
  assert.equal(posted.length, 2);
  assert.match(posted[0].text, /✅ Voting ended: \*#0\* — payout 0 passed\. It can be executed from/);
  assert.match(posted[1].text, /❌ Voting ended: \*#1\* — payout 1 was defeated\./);
  await scan(60n * MIN);
  assert.equal(posted.length, 2, "no repeats");

  // The timelock passes: an Execute button comes with the notice.
  await scan(101n * MIN);
  assert.match(posted[2].text, /▶️ \*#0\* — payout 0 can be executed now with `\/execute 0`/);
  assert.ok(posted[2].buttons.flat().some((b) => b.cmd === "execute 0"));

  // The last hour of its 72-hour window.
  await scan(100n * MIN + 72n * 60n * MIN - 30n * MIN);
  assert.match(posted[3].text, /⏳ \*#0\* — payout 0 must be executed by .* or it expires: `\/execute 0`/);

  p0.state = "Expired";
  await scan(100n * MIN + 73n * 60n * MIN);
  assert.match(posted[4].text, /⌛ \*#0\* — payout 0 expired/);
  assert.equal(posted.length, 5);
});

test("notifications: a proposal that passes with no timelock is ready at once; executing it posts nothing", async () => {
  const p0 = proposal(0, "Active");
  const { posted, scan } = setup([p0]);
  await scan(0n);
  p0.state = "Succeeded";
  await scan(10n * MIN);
  assert.match(posted[0].text, /✅ Voting ended: \*#0\* — payout 0 passed and can be executed now with `\/execute 0`/);
  p0.state = "Executed";
  await scan(11n * MIN);
  assert.equal(posted.length, 1);
});

test("notifications: a new orbit (after a model switch) starts quietly, and board DAOs are left out", async () => {
  const p0 = proposal(0, "Active");
  const { links, posted, scan } = setup([p0]);
  await scan(0n);
  links["telegram:-100"] = { ...links["telegram:-100"], orbitId: "qv.ark.orbits.testnet", model: "quadratic" };
  p0.state = "Defeated";
  await scan(MIN);
  assert.equal(posted.length, 0, "the old orbit's stages don't apply to the new one");
  assert.equal(links["telegram:-100"].watch.orbit, "qv.ark.orbits.testnet");

  links["telegram:-100"] = { daoId: "b.sputnikv2.testnet", orbitId: null, model: "board" };
  await scan(2n * MIN);
  assert.equal(posted.length, 0);
  assert.equal(links["telegram:-100"].watch, undefined);
});
