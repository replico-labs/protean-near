import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { toUnits, fromUnits } from "../src/near/amounts.js";
import { describeKind } from "../src/near/kinds.js";
import { proposalButtons, encodeButton, decodeButton } from "../src/buttons.js";
import { parseCommandText, splitForTelegram } from "../src/platforms/telegram.js";
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
