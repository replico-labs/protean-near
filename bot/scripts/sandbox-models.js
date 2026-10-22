// Runs each governance model's own mechanics on a local NEAR node, through
// the bot's commands: liquid delegation, optimistic challenges, delegate
// elections and recalls, sortition draws, Sowellian bets and resolution,
// and decision markets. One DAO per model, each in its own chat.
//
//   node --env-file=.env.sandbox scripts/sandbox-models.js [model...]
//
// Needs a sandbox prepared by scripts/sandbox-setup.js with the contracts
// published (scripts/publish-contracts.js --yes). With model names, runs
// only those. Councils serve 10-minute terms here so elections can start.
import assert from "node:assert/strict";

process.env.TERM_MINUTES ??= "10";
const { RUN, account, link, useChat, run, advance, step, propose, pass } = await import("./sandbox-lib.js");
const { nearToYocto } = await import("near-api-js");
const { operatorAccount, availableBalance, view } = await import("../src/near/client.js");

const E18 = 10n ** 18n;
const only = process.argv.slice(2);
const tokens = async (who) => BigInt(await view(link().tokenId, "ft_balance_of", { account_id: account(who) })) / E18;
const proposal = (id) => view(link().orbitId, "get_proposal", { id });

/**
 * A fresh DAO running `model` in its own chat: alice creates it with
 * 1,000,000 tokens and shares them; alice and bob stake 250k, carol 200k,
 * dave 100k, and everyone keeps 50k unstaked for bonds and bets. The
 * treasury gets 5 NEAR.
 */
async function newDao(chat, model, symbol, members = []) {
  useChat(chat);
  step(`A ${model} DAO`);
  await run(1, `createdao ${model.toLowerCase().slice(0, 6)}${RUN} ${symbol} 1000000 ${model} ${members.map(account).join(" ")}`, { expect: /is live/ });
  for (const u of [2, 3, 4]) await run(u, "wallet", { expect: /Your account/ });
  for (const [u, amount] of [[2, 300000], [3, 250000], [4, 150000]]) await run(1, `send ${amount} ${symbol} ${account(u)}`);
  for (const [u, amount] of [[1, 250000], [2, 250000], [3, 200000], [4, 100000]]) await run(u, `stake ${amount}`);
  await operatorAccount().transfer({ receiverId: link().daoId, amount: nearToYocto("5") });
  await advance(0.1);
}

const runs = {
  async liquid() {
    await newDao(-2001, "liquid", "LIQ");
    step("Liquid: dave delegates to carol, carol to bob; only alice and bob vote");
    await run(4, `delegate ${account(3)}`);
    await run(3, `delegate ${account(2)}`);
    const id = await propose(`pay 1 NEAR ${account(4)} liquid payout`);
    await run(2, `vote ${id} for`);
    await run(1, `vote ${id} against`);
    // Each delegator's stake follows their chain to the first account that voted: bob.
    await run(4, `resolve ${id}`);
    await run(3, `resolve ${id}`);
    const p = await proposal(id);
    assert.equal(BigInt(p.for_votes) / E18, 550000n, "bob 250k + carol 200k + dave 100k");
    assert.equal(BigInt(p.against_votes) / E18, 250000n);
    console.log("  ✔ dave's and carol's stake followed their delegation chains to bob's vote: 550k for, 250k against");
    const before = await availableBalance(account(4));
    await advance(2.5);
    await run(3, `execute ${id}`, { expect: /executed/i });
    assert.ok((await availableBalance(account(4))) - before >= nearToYocto("0.99"));
    console.log("  ✔ it passed and dave was paid 1 NEAR");
  },

  async optimistic() {
    await newDao(-2002, "optimistic", "OPT");
    step("Optimistic: an unchallenged proposal passes when its challenge window ends");
    const quiet = await propose(`pay 1 NEAR ${account(4)} unchallenged`);
    assert.equal((await proposal(quiet)).state, "ChallengeWindow");
    await advance(62);
    await run(3, `execute ${quiet}`, { expect: /executed/i });
    console.log("  ✔ nobody challenged it, so it executed without a vote");

    step("Optimistic: bob challenges with a bond, the vote rejects the proposal, and bob gets his bond back");
    const contested = await propose(`pay 2 NEAR ${account(1)} contested`);
    const before = await tokens(2);
    await run(2, `challenge ${contested}`, { expect: /^(?!Couldn't).*challeng/i });
    assert.equal(before - (await tokens(2)), 1000n, "the bond is 0.1% of supply");
    await run(1, `vote ${contested} for`);
    await run(2, `vote ${contested} against`);
    await run(3, `vote ${contested} against`);
    await advance(2.5);
    assert.equal((await proposal(contested)).state, "Defeated");
    await run(2, `resolvechallenge ${contested}`, { expect: /bond/i });
    assert.equal(await tokens(2), before, "bond returned");
    console.log("  ✔ 450k against 250k defeated it, and the 1,000 OPT bond went back to bob");
  },

  async delegate() {
    await newDao(-2003, "delegate", "DEL", [1, 2, 3]);
    step("Delegate: the first council (alice, bob, carol) proposes and votes, one seat one vote");
    const id = await propose(`pay 1 NEAR ${account(4)} council payout`);
    await pass(id, [1, 2]);
    console.log("  ✔ two of three seats passed it and it executed");

    step("Delegate: after the term, an election seats the candidates stakers vote for");
    await advance(11);
    await run(4, "startelection", { expect: /Election #0 is open/ });
    await run(4, "declarecandidacy", { expect: /is standing/ });
    await run(3, "declarecandidacy", { expect: /is standing/ });
    await advance(31);
    await run(4, `voteinelection ${account(4)}`);
    await run(2, `voteinelection ${account(4)} ${account(3)}`);
    await run(1, `voteinelection ${account(3)}`);
    await advance(61);
    await run(1, "finalizeelection", { expect: /new council/ });
    const council = await view(link().orbitId, "get_council");
    assert.deepEqual(council, [account(3), account(4)], "carol 450k (alice + bob), then dave 350k (dave + bob)");
    console.log("  ✔ the new council is carol and dave");

    step("Delegate: stakers recall a council member");
    const recall = Number(/Recall #(\d+)/.exec((await run(1, `recall ${account(4)}`, { expect: /Recall #\d+/ })).text)[1]);
    for (const u of [1, 2, 3]) await run(u, `voterecall ${recall} for`);
    await advance(61);
    await run(1, `finalizerecall ${recall}`, { expect: /was removed/ });
    assert.deepEqual(await view(link().orbitId, "get_council"), [account(3)]);
    console.log("  ✔ dave was recalled; his seat waits for the next election");
  },

  async sortition() {
    await newDao(-2004, "sortition", "SRT", [1, 2, 3]);
    step("Sortition: stakers join the pool; after the term a council is drawn from it");
    for (const u of [2, 3, 4]) await run(u, "registereligible", { expect: /in the pool/ });
    await advance(11);
    await run(1, "draw", { expect: /new council/ });
    const council = await view(link().orbitId, "get_council");
    assert.deepEqual([...council].sort(), [account(2), account(3), account(4)].sort(), "three seats, three in the pool");
    console.log(`  ✔ drawn: ${council.join(", ")}`);
    const id = await propose(`pay 1 NEAR ${account(1)} drawn council payout`, 4);
    await run(1, `vote ${id} for`, { expect: /Only council members vote/ });
    await pass(id, [2, 4]);
    console.log("  ✔ the drawn council proposed and passed a payout; alice, no longer on it, couldn't vote");
  },

  async sowellian() {
    await newDao(-2005, "sowellian", "SOW");
    step("Sowellian: a proposal with a bond is approved by stake, then people bet on its outcome");
    const aliceBefore = await tokens(1);
    const id = await propose(`pay 1 NEAR ${account(4)} growth experiment`);
    assert.equal(aliceBefore - (await tokens(1)), 100n, "the proposal bond is 0.01% of supply");
    for (const u of [1, 2, 3]) await run(u, `vote ${id} for`);
    await advance(1.5);
    assert.equal((await proposal(id)).state, "Positions");
    await run(2, `position ${id} yes 1000`);
    await run(3, `position ${id} no 500`);
    await advance(62);
    await run(3, `execute ${id}`, { expect: /executed/i });
    console.log("  ✔ approved, bets taken (1,000 YES, 500 NO), and executed");

    step("Sowellian: after measuring, alice proposes Success, carol disputes, and stakers adjudicate");
    await advance(61);
    await run(1, `proposeresolution ${id} success`);
    await run(3, `dispute ${id}`);
    await run(1, `adjudicate ${id} success`);
    await run(2, `adjudicate ${id} success`);
    await run(3, `adjudicate ${id} failure`);
    await advance(61);
    await run(1, `finalizeresolution ${id}`, { expect: /resolved: \*success\*/ });
    const bobBefore = await tokens(2);
    await run(2, `claimposition ${id}`, { expect: /collected/ });
    assert.equal((await tokens(2)) - bobBefore, 1500n, "YES takes the whole pool");
    await run(3, `claimposition ${id}`, { expect: /nothing to collect/ });
    assert.equal(await tokens(1), aliceBefore, "alice's proposal and resolution bonds came back");
    console.log("  ✔ adjudicated Success (500k to 200k); bob collected the 1,500 pool, and alice got both bonds back");
  },

  async decisionMarkets() {
    await newDao(-2006, "decisionMarkets", "DMK");
    step("Decision markets: the proposer seeds pass and fail markets; traders who back it bid up the pass price");
    const id = await propose(`pay 1 NEAR ${account(4)} market-approved payout`);
    // Small NEAR amounts: the sandbox's gas price is ten times testnet's, and each account starts with 1 NEAR.
    await run(1, `seed ${id} 1000 0.2`, { expect: /Trading is open/ });
    await run(2, `split ${id} 2 NEAR`, { expect: /your account has 0\.\d+ spendable/ });
    await run(2, `split ${id} 0.2 NEAR`);
    await run(2, `trade ${id} pass 0.15 NEAR`);
    const [exchange] = await view(link().orbitId, "get_exchange", { id });
    assert.ok(BigInt(exchange.pass.near) * BigInt(exchange.fail.token) > BigInt(exchange.fail.near) * BigInt(exchange.pass.token), "pass prices the token higher");
    await advance(62);
    assert.equal((await proposal(id)).state, "Succeeded");
    await run(3, `execute ${id}`, { expect: /executed/i });
    console.log("  ✔ the pass market's average price beat the fail market's, so it passed and executed");
    await run(2, `redeem ${id}`, { expect: /Redeemed/ });
    await run(1, `reclaimliquidity ${id}`, { expect: /Returned/ });
    console.log("  ✔ bob redeemed his winning units, and the pass market's liquidity went back to alice");
  },
};

for (const [model, fn] of Object.entries(runs)) {
  if (only.length && !only.includes(model)) continue;
  await fn();
}
console.log(`\nAll model checks passed${only.length ? ` (${only.join(", ")})` : ""}.`);
