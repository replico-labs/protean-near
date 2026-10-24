import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { proposalButtons, betPhase, decodeButton, encodeButton, BUTTON_COMMANDS } from "../src/buttons.js";
import { services } from "../src/platforms/services.js";
import { runButton } from "../src/platforms/commands.js";
import { share } from "../src/platforms/buttonMenus.js";
import { scanChat, markAnnounced } from "../src/platforms/notifier.js";

const E18 = 10n ** 18n;
const E24 = 10n ** 24n;
const NOW = 1_000n;
const ME = "tg42.protean.testnet";
const cmds = (rows) => rows.flat().filter((b) => b.cmd).map((b) => b.cmd);
const ctx = (args) => ({ platform: "telegram", chatId: "-100", userId: "42", args, cmd: (n) => `/${n}` });

let links;
beforeEach(() => {
  links = {
    "telegram:-100": { daoId: "ark.sputnik.protean.testnet", orbitId: "sw.ark.protean.testnet", model: "sowellian", tokenId: "token.ark", stakingId: "staking.ark" },
  };
  Object.assign(services, {
    db: {
      getChatDao: (p, c) => links[`${p}:${c}`] ?? null,
      setChatDao: (p, c, l) => (links[`${p}:${c}`] = l),
    },
    staking: { ...services.staking, tokenMetadata: async () => ({ symbol: "ARK", decimals: 18 }), tokenBalance: async () => 1234n * E18 },
    wallets: { ...services.wallets, findUserAccountId: async (p, u) => (u === "42" ? ME : null), availableBalance: async () => 2n * E24, gasHoldNear: async () => 3n * 10n ** 23n },
    orbit: {
      ...services.orbit,
      getModel: async () => ({ Sowellian: { resolution_bond: String(50n * E18), challenge_bond: String(75n * E18) } }),
      getHoldings: async () => ({ pass_near: String(E24 / 2n), fail_near: "0", pass_token: "0", fail_token: "0" }),
    },
  });
});

test("buttons: Sowellian through its phases", () => {
  const sw = (state, bet) => cmds(proposalButtons("sowellian", 4, state, null, { bet, now: NOW }));
  assert.deepEqual(sw("Active", null), ["vote 4 for", "vote 4 against", "vote 4 abstain", "proposal 4"]);
  assert.deepEqual(sw("Positions", null), ["ask amount position 4 yes", "ask amount position 4 no", "proposal 4"]);
  assert.deepEqual(sw("Succeeded", null), ["execute 4", "proposal 4"]);
  const bet = { criteria: "Human", measurement_deadline: "2000" };
  assert.deepEqual(sw("Executed", bet), ["proposal 4"], "still measuring");
  assert.deepEqual(sw("Executed", { ...bet, measurement_deadline: "500" }), ["ask sure proposeresolution 4 success", "ask sure proposeresolution 4 failure", "proposal 4"]);
  assert.deepEqual(sw("Executed", { ...bet, measurement_deadline: "500", criteria: { Oracle: {} } }), ["finalizeresolution 4", "proposal 4"]);
  assert.deepEqual(sw("Executed", { ...bet, resolver: ME, challenge_deadline: "2000" }), ["ask sure dispute 4", "proposal 4"]);
  assert.deepEqual(sw("Executed", { ...bet, resolver: ME, challenge_deadline: "900" }), ["finalizeresolution 4", "proposal 4"], "undisputed: lock it in");
  assert.deepEqual(sw("Executed", { ...bet, resolver: ME, challenger: "x", adjudication_end: "2000" }), ["adjudicate 4 success", "adjudicate 4 failure", "proposal 4"]);
  assert.deepEqual(sw("Executed", { ...bet, resolver: ME, challenger: "x", adjudication_end: "900" }), ["finalizeresolution 4", "proposal 4"]);
  assert.deepEqual(sw("Executed", { ...bet, outcome: "Success" }), ["claimposition 4", "proposal 4"]);
  assert.equal(betPhase({ ...bet, outcome: "Failure" }, NOW), "Resolved");
});

test("buttons: decision markets trade while open, redeem after; other models keep their buttons", () => {
  const dm = (state, exchange) => cmds(proposalButtons("decisionMarkets", 2, state, null, { exchange, now: NOW }));
  assert.deepEqual(dm("Active", { opened_at: null, deadline: "2000" }), ["proposal 2"], "unseeded: seeding is typed");
  assert.deepEqual(dm("Active", { opened_at: "1", deadline: "2000" }), [
    "ask amount trade 2 pass near", "ask amount trade 2 fail near", "ask amount trade 2 pass token", "ask amount trade 2 fail token",
    "ask amount split 2 near", "ask amount split 2 token", "proposal 2",
  ]);
  assert.deepEqual(dm("Succeeded", { opened_at: "1", deadline: "900" }), ["redeem 2", "execute 2", "proposal 2"]);
  assert.deepEqual(cmds(proposalButtons("board", 1, "InProgress")), ["vote 1 for", "vote 1 against", "proposal 1"]);
  assert.deepEqual(cmds(proposalButtons("conviction", 1, "Active")), ["support 1", "queue 1", "proposal 1"]);
  assert.deepEqual(cmds(proposalButtons("optimistic", 1, "ChallengeWindow")), ["challenge 1", "proposal 1"]);
  // Every button fits Telegram's 64 bytes, decodes, and is allowed.
  for (const c of [...dm("Active", { opened_at: "1", deadline: "2000" }), "position 12 yes 1234567.123456", "trade 12 pass 0.5 near"]) {
    const [name] = decodeButton(encodeButton(c));
    assert.ok(BUTTON_COMMANDS.has(name), name);
  }
});

test("menus: how much, from what the presser holds", async () => {
  assert.equal(share(1234n * E18, 18, 25), "308.5");
  assert.equal(share(1n, 18, 10), null, "too small to offer");
  const menu = await runButton("ask", ctx(["amount", "position", "4", "yes"]));
  assert.equal(menu.menu, true);
  assert.match(menu.text, /^how much do you want to put behind \*YES \(it works\)\* on #4\? You have 1234 ARK\.\nOr type `\/position 4 yes <amount>`/);
  assert.deepEqual(cmds(menu.buttons), ["position 4 yes 123.4", "position 4 yes 308.5", "position 4 yes 617", "position 4 yes 1234", "proposal 4"]);

  links["telegram:-100"] = { ...links["telegram:-100"], orbitId: "dm.ark.protean.testnet", model: "decisionMarkets" };
  const split = await runButton("ask", ctx(["amount", "split", "2", "near"]));
  assert.match(split.text, /You have 1\.7 NEAR/, "less the gas hold");
  assert.equal(cmds(split.buttons)[3], "split 2 1.7 near");
  const trade = await runButton("ask", ctx(["amount", "trade", "2", "pass", "near"]));
  assert.deepEqual(cmds(trade.buttons), ["trade 2 pass 0.05 near", "trade 2 pass 0.125 near", "trade 2 pass 0.25 near", "trade 2 pass 0.5 near", "proposal 2"]);
  const none = await runButton("ask", ctx(["amount", "trade", "2", "fail", "token"]));
  assert.match(none.text, /you hold no fail ARK units\. Split some first: `\/split 2 <amount> ARK`/);
  assert.match((await runButton("ask", { ...ctx(["amount", "trade", "2", "pass", "near"]), userId: "7" })).text, /you don't have an account here yet/);
  assert.equal((await runButton("ask", ctx(["amount", "position", "2", "yes"]))).text, "That button doesn't do anything any more.", "the wrong model");
});

test("menus: are you sure, before posting a bond", async () => {
  const dispute = await runButton("ask", ctx(["sure", "dispute", "4"]));
  assert.match(dispute.text, /posts the 75 ARK dispute bond/);
  assert.deepEqual(cmds(dispute.buttons), ["dispute 4", "proposal 4"]);
  const resolve = await runButton("ask", ctx(["sure", "proposeresolution", "4", "failure"]));
  assert.match(resolve.text, /propose that it didn't meet its goal for #4\? It posts the 50 ARK resolution bond/);
  assert.deepEqual(cmds(resolve.buttons), ["proposeresolution 4 failure", "proposal 4"]);
  assert.equal((await runButton("ask", ctx(["sure", "execute", "4"]))).text, "That button doesn't do anything any more.");
});

test("notices: new proposals from elsewhere, model steps, each with its buttons; the chat's own proposals aren't repeated", async () => {
  const orbit = links["telegram:-100"].orbitId;
  const proposals = [{ id: 0, proposer: ME, description: "grow", state: "Active", executable_after: null }];
  let bet = null;
  Object.assign(services.orbit, {
    getProposalCount: async () => proposals.length,
    getProposals: async (o, from, limit) => proposals.slice(from, from + limit),
    getModel: async () => ({ Sowellian: { execution_period: "1" } }),
    getBet: async () => bet,
  });
  const posted = [];
  const scan = (now) => scanChat("telegram", "-100", links["telegram:-100"], (c, text, buttons) => posted.push({ text, cmds: cmds(buttons) }), (n) => `/${n}`, now);
  await scan(NOW);
  assert.equal(posted.length, 0, "the first look only records");

  proposals.push({ id: 1, proposer: "someone.testnet", description: "made on chain", state: "Active" });
  proposals.push({ id: 2, proposer: ME, description: "made here", state: "Active" });
  markAnnounced("telegram", "-100", 2, "Active");
  proposals[0].state = "Positions";
  await scan(NOW);
  assert.deepEqual(posted.map((p) => p.text), [
    "🎲 *#0* — grow was approved. Positions are open: back YES or NO on whether it works.",
    "📝 New proposal: *#1* — made on chain, by `someone.testnet`.",
  ]);
  assert.deepEqual(posted[0].cmds, ["ask amount position 0 yes", "ask amount position 0 no", "proposal 0"]);
  assert.deepEqual(posted[1].cmds, ["vote 1 for", "vote 1 against", "vote 1 abstain", "proposal 1"]);

  posted.length = 0;
  Object.assign(proposals[0], { state: "Executed" });
  bet = { criteria: "Human", measurement_deadline: "2000" };
  await scan(NOW);
  assert.equal(posted.length, 0, "measuring: nothing to do yet");
  await scan(3000n);
  assert.match(posted[0].text, /measurement period is over\. Propose whether it worked\./);
  assert.deepEqual(posted[0].cmds, ["ask sure proposeresolution 0 success", "ask sure proposeresolution 0 failure", "proposal 0"]);
  bet = { ...bet, resolver: ME, proposed_outcome: "Success", challenge_deadline: "9000000000000" };
  await scan(4000n);
  assert.match(posted[1].text, /`tg42\.protean\.testnet` proposed that it was a \*success\*\. It can be disputed until/);
  bet = { ...bet, outcome: "Success" };
  await scan(5000n);
  assert.match(posted[2].text, /resolved: \*success\*\. Winning positions can be claimed\./);
  assert.deepEqual(posted[2].cmds, ["claimposition 0", "proposal 0"]);
  await scan(6000n);
  assert.equal(posted.length, 3, "nothing twice");
});
