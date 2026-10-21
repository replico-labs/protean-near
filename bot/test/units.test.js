import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { toUnits, fromUnits } from "../src/near/amounts.js";
import { describeKind } from "../src/near/kinds.js";
import { proposalButtons, encodeButton, decodeButton } from "../src/buttons.js";
import { parseCommandText, splitForTelegram, menuFor, syncChatMenu } from "../src/platforms/telegram.js";
import { argsFromOptions, buildSlashCommands, toDiscordMarkdown } from "../src/platforms/discord.js";
import { COMMANDS } from "../src/platforms/commands.js";
import { kindFixtures, modelFixtures, policyFixtures } from "./kindFixtures.js";
import { MODELS, MODULE_CONTRACT, ORBIT_PREFIX } from "../src/near/models.js";

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
