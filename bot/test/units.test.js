import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { toUnits, fromUnits } from "../src/near/amounts.js";
import { describeKind, kindTokens, rheaSwap, liquidStake, intentsDeposit, intentsWithdraw } from "../src/near/kinds.js";
import { proposalButtons, encodeButton, decodeButton } from "../src/buttons.js";
import { parseCommandText, splitForTelegram, menuFor, syncChatMenu } from "../src/platforms/telegram.js";
import { argsFromOptions, buildSlashCommands, toDiscordMarkdown } from "../src/platforms/discord.js";
import { COMMANDS } from "../src/platforms/commands.js";
import { kindFixtures, modelFixtures, policyFixtures } from "./kindFixtures.js";
import { supabaseUrl } from "../src/supabaseError.js";
import { MODELS, MODULE_CONTRACT, ORBIT_PREFIX, executionHorizonNs, modelConfig } from "../src/near/models.js";

test("amounts convert without floating point", () => {
  assert.equal(toUnits("1.5", 24), 1_500_000_000_000_000_000_000_000n);
  assert.equal(toUnits("0.000000000000000000000001", 24), 1n);
  assert.equal(toUnits("10", 0), 10n);
  for (const bad of ["", "0", "-1", "1e3", "1.", ".5", "1,5", "abc", "1.0000001"]) assert.equal(toUnits(bad, 6), null, bad);
  assert.equal(fromUnits(1_500_000_000_000_000_000_000_000n, 24), "1.5");
  assert.equal(fromUnits("2000000", 6), "2");
  assert.equal(fromUnits(1n, 24), "<0.0001");
  assert.equal(fromUnits(0n, 24), "0");
});

test("every model but board has its own module contract and orbit prefix", () => {
  for (const model of Object.keys(MODELS).filter((m) => m !== "board")) {
    const contract = MODULE_CONTRACT[model];
    assert.ok(contract, model);
    assert.ok(ORBIT_PREFIX[model], model);
    // orbit_token_weighted is built from orbits/modules/token-weighted
    const dir = contract.replace(/^orbit_/, "").replaceAll("_", "-");
    assert.ok(existsSync(new URL(`../../orbits/modules/${dir}/Cargo.toml`, import.meta.url)), contract);
  }
  assert.equal(new Set(Object.values(MODULE_CONTRACT)).size, 9);
});

test("the committed fixtures match kinds.js and models.js", () => {
  for (const [file, make] of [["kinds.json", kindFixtures], ["models.json", modelFixtures], ["policies.json", policyFixtures]]) {
    const committed = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(make())), `${file} is stale: run node scripts/write-kind-fixtures.js`);
  }
});

test("kinds read as sentences", () => {
  const f = kindFixtures();
  assert.equal(describeKind(f.transferNear, { formatNear: () => "1.5" }), "Pay 1.5 NEAR to maya.testnet");
  assert.match(describeKind(f.transferToken), /^Pay 250000000000000000000 of token\.mydao/);
  assert.equal(describeKind(f.signal), "Signal vote (nothing is executed)");
  assert.equal(describeKind(f.swap), "Swap governance to q.mydao.orbits.testnet");
});

test("buttons round-trip and refuse forgeries", () => {
  assert.deepEqual(proposalButtons("tokenWeighted", 7, "Active")[0].map((b) => b.cmd), ["vote 7 for", "vote 7 against", "vote 7 abstain"]);
  assert.deepEqual(proposalButtons("board", 7, "InProgress")[0].map((b) => b.cmd), ["vote 7 for", "vote 7 against"]);
  assert.deepEqual(proposalButtons("optimistic", 7, "ChallengeWindow")[0].map((b) => b.cmd), ["challenge 7"]);
  assert.deepEqual(proposalButtons("conviction", 7, "Active")[0].map((b) => b.cmd), ["support 7", "queue 7"]);
  assert.deepEqual(proposalButtons("tokenWeighted", 7, "Succeeded")[0], [{ label: "▶️ Execute", cmd: "execute 7" }]);
  assert.deepEqual(decodeButton(encodeButton("vote 7 for")), ["vote", ["7", "for"]]);
  assert.equal(decodeButton("c:vote 7; rm"), null);
  assert.equal(decodeButton("x:vote 7 for"), null);
});

test("Telegram command parsing", () => {
  assert.deepEqual(parseCommandText("/vote@protean_near_bot 3 for"), ["vote", ["3", "for"]]);
  assert.deepEqual(parseCommandText("/link `mydao.sputnikv2.testnet`  tw.orbit.testnet"), ["link", ["mydao.sputnikv2.testnet", "tw.orbit.testnet"]]);
  assert.deepEqual(parseCommandText("/help"), ["help", []]);
  assert.equal(parseCommandText("hello /vote"), null);
  const chunks = splitForTelegram(Array.from({ length: 50 }, () => "x".repeat(100)).join("\n"), 1000);
  assert.ok(chunks.every((c) => c.length <= 1000));
  assert.equal(chunks.join("\n").length, 50 * 101 - 1);
});

test("Discord slash commands build, and options become args", () => {
  const defs = buildSlashCommands();
  assert.equal(defs.length, Object.keys(COMMANDS).length);
  assert.ok(defs.every((d) => /^[a-z]{1,32}$/.test(d.name)));
  const pay = COMMANDS.pay;
  const values = { amount: "5", currency: "NEAR", to: "`maya.testnet`", description: "logo  design" };
  assert.deepEqual(argsFromOptions(pay, (n) => values[n]), ["5", "NEAR", "maya.testnet", "logo", "design"]);
  assert.equal(toDiscordMarkdown("*bold* `*code*`"), "**bold** `*code*`");
});

test("Telegram's command menu follows the chat's model", async () => {
  const names = (model) => menuFor(model).map((c) => c.command);
  // No DAO yet: getting started, nothing that needs a DAO.
  assert.ok(["help", "createdao", "link", "wallet"].every((c) => names(null).includes(c)));
  assert.deepEqual(names(null), ["help", "createdao", "link", "wallet", "send"]);
  // Each model gets its own commands and not the others'.
  assert.ok(names("tokenWeighted").includes("vote") && !names("tokenWeighted").includes("support"));
  assert.ok(names("conviction").includes("support") && !names("conviction").includes("vote"));
  assert.ok(names("delegate").includes("startelection") && !names("tokenWeighted").includes("startelection"));
  assert.ok(names("decisionMarkets").includes("trade") && !names("quadratic").includes("trade"));
  // Telegram's limits: at most 100 commands, names of 1-32 lowercase characters.
  for (const model of [null, ...Object.keys(MODELS)]) {
    assert.ok(menuFor(model).length <= 100, String(model));
    assert.ok(menuFor(model).every((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.length >= 1), String(model));
  }

  const calls = [];
  const api = {
    setMyCommands: async (commands, opts) => calls.push(["set", commands.length, opts.scope]),
    deleteMyCommands: async (opts) => calls.push(["delete", opts.scope]),
  };
  await syncChatMenu(api, -100, { model: "conviction" });
  await syncChatMenu(api, -100, null);
  assert.deepEqual(calls, [
    ["set", menuFor("conviction").length, { type: "chat", chat_id: -100 }],
    ["delete", { type: "chat", chat_id: -100 }],
  ]);
  // A failure (say the bot left the chat) is logged, not thrown.
  const failing = { setMyCommands: async () => Promise.reject(Object.assign(new Error("Forbidden"), { description: "Forbidden" })) };
  const error = console.error;
  console.error = () => {};
  await syncChatMenu(failing, -100, { model: "quadratic" });
  console.error = error;
});

test("swaps and liquid staking read as sentences", () => {
  const swap = rheaSwap({
    rhea: "ref.testnet",
    wrapNear: "wrap.testnet",
    tokenIn: "NEAR",
    amountIn: 10n ** 24n,
    route: [{ pool_id: 7, token_in: "wrap.testnet", token_out: "usdc.testnet", amount_in: String(10n ** 24n), min_amount_out: "4950000" }],
  });
  const formatNear = (y) => String(BigInt(y) / 10n ** 24n);
  const formatToken = (id, amount) => `${Number(amount) / 1e6} USDC`;
  assert.equal(describeKind(swap, { formatNear, formatToken }), "Swap 1 NEAR for at least 4.95 USDC on Rhea (ref.testnet)");
  assert.deepEqual(kindTokens(swap), ["usdc.testnet"]);
  assert.equal(describeKind(liquidStake("linear.testnet", 5n * 10n ** 24n), { formatNear }), "Liquid-stake 5 NEAR with linear.testnet");
});

test("NEAR Intents proposals read as sentences", () => {
  const formatNear = (y) => String(BigInt(y) / 10n ** 24n);
  const formatToken = (id, amount) => `${amount} ${id}`;
  const deposit = intentsDeposit({ intents: "intents.near", wrapNear: "wrap.near", token: "NEAR", amount: 2n * 10n ** 24n, depositAddress: "b".repeat(64) });
  assert.equal(describeKind(deposit, { formatNear, formatToken }), "Send 2 NEAR into NEAR Intents to fill quote bbbbbbbbbb…");
  assert.deepEqual(kindTokens(deposit), []);
  const withdraw = intentsWithdraw({ intents: "intents.near", token: "usdc.near", amount: 5n, receiver: "dao.near" });
  assert.equal(describeKind(withdraw, { formatNear, formatToken }), "Withdraw 5 usdc.near from NEAR Intents to dao.near");
});

test("how long a proposal can stay executable, per model", () => {
  const supply = 1_000_000n * 10n ** 18n;
  const settings = (m) => Object.values(modelConfig(m, supply, 3))[0];
  const tw = settings("tokenWeighted");
  assert.equal(executionHorizonNs("tokenWeighted", tw), BigInt(tw.voting_delay) + BigInt(tw.voting_period) + BigInt(tw.timelock) + BigInt(tw.execution_period));
  for (const m of ["quadratic", "liquid", "optimistic", "delegate", "sortition", "sowellian"]) assert.ok(executionHorizonNs(m, settings(m)) > 0n, m);
  assert.equal(executionHorizonNs("conviction", settings("conviction")), null);
  assert.equal(executionHorizonNs("decisionMarkets", settings("decisionMarkets")), null);
  assert.equal(executionHorizonNs("board", null, 99n), 99n);
});

test("Chain Signatures: a signature in the signing network's format makes a transaction sent from the DAO's address", async () => {
  process.env.CHAIN_SIGNER_ID = "signer.testnet";
  const { privateKeyToAccount } = await import("viem/accounts");
  const { sign } = await import("viem/accounts");
  const { signaturesFrom, signKind } = await import("../src/near/chainsig.js");
  const evm = await import("../src/near/evm.js");
  const key = "0x" + "11".repeat(32);
  const dao = privateKeyToAccount(key).address;
  const chain = evm.base();
  const txs = evm.unsignedTxs(chain, evm.aaveSupplyCalls(chain, dao, 5_000_000n), { nonce: 7, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
  assert.deepEqual(txs.map((t) => t.maxCost), [80_000n * 1_000_000_000n, 350_000n * 1_000_000_000n]);

  // The proposal asks for one signature per transaction, in order.
  const kind = signKind(txs.map((t) => t.hash));
  const requests = kind.FunctionCall.actions.map((a) => JSON.parse(Buffer.from(a.args, "base64").toString()).request);
  assert.deepEqual(requests.map((r) => r.payload_v2.Ecdsa), txs.map((t) => t.hash.slice(2)));
  assert.ok(kind.FunctionCall.actions.every((a) => a.deposit === "1"));
  assert.match(describeKind(kind), /^Sign 2 transactions with the DAO's own EVM key \(Chain Signatures, signer\.testnet\)/);

  // The signing network answers each with { big_r (compressed R), s, recovery_id }, in the execution's receipts.
  const answers = [];
  for (const t of txs) {
    const sig = await sign({ hash: t.hash, privateKey: key });
    answers.push({ scheme: "Secp256k1", big_r: { affine_point: `0${2 + sig.yParity}${sig.r.slice(2)}`.toUpperCase() }, s: { scalar: sig.s.slice(2).toUpperCase() }, recovery_id: sig.yParity });
  }
  const outcome = {
    receipts_outcome: [
      { outcome: { executor_id: "orbit.testnet", status: { SuccessValue: "" } } },
      ...answers.map((a) => ({ outcome: { executor_id: "signer.testnet", status: { SuccessValue: Buffer.from(JSON.stringify(a)).toString("base64") } } })),
    ],
  };
  const signatures = signaturesFrom(outcome);
  assert.equal(signatures.length, 2);
  for (const [i, t] of txs.entries()) {
    const signed = await evm.signedTx(t.serialized, signatures[i], dao);
    assert.ok(signed.startsWith("0x02"));
  }
  // A signature from anyone else is refused.
  await assert.rejects(evm.signedTx(txs[0].serialized, signatures[0], "0x000000000000000000000000000000000000dEaD"), /not the DAO's/);
  delete process.env.CHAIN_SIGNER_ID;
});

test("a proposal's transactions travel in its description, hidden from what people read", async () => {
  const evm = await import("../src/near/evm.js");
  const text = evm.withTxs("Supply 5 USDC to Aave", { chain: 84532, from: "0xabc", txs: ["0x02f0"] });
  assert.equal(evm.readable(text), "Supply 5 USDC to Aave");
  assert.deepEqual(evm.txsIn(text), { chain: 84532, from: "0xabc", txs: ["0x02f0"] });
  assert.equal(evm.txsIn("Pay Maya"), null);
});

test("Hyperliquid actions hash exactly as Hyperliquid's own SDK signs them", async () => {
  const hl = await import("../src/near/hyperliquid.js");
  const { sign } = await import("viem/accounts");
  // The vector from hyperliquid-python-sdk tests/signing_test.py (test_sign_usd_transfer_action, testnet).
  const action = { ...hl.usdSend("0x5e9ee1089755c3435139848e47e6635505d5a13a", "1", 1687816341423), hyperliquidChain: "Testnet" };
  const sig = await sign({ hash: hl.digest(action), privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123" });
  assert.equal(sig.r, "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073");
  assert.equal(sig.s, "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7");
  assert.equal(27 + sig.yParity, 27);

  // Nonces: as late as Hyperliquid allows (just under a day ahead), accepted until about three days out.
  const now = 1_700_000_000_000;
  const { nonce, validUntil } = hl.nonceForProposal(now);
  assert.equal(nonce, now + 23 * 3_600_000);
  assert.equal(validUntil.getTime(), now + 23 * 3_600_000 + 47 * 3_600_000);
});

test("SUPABASE_URL keeps only the project URL, even when the REST path is pasted", () => {
  assert.equal(supabaseUrl("https://abcd.supabase.co"), "https://abcd.supabase.co");
  assert.equal(supabaseUrl(" https://abcd.supabase.co/rest/v1/ "), "https://abcd.supabase.co");
  assert.throws(() => supabaseUrl("abcd.supabase.co"), /Project URL/);
});
