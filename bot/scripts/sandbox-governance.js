// Runs changing how a DAO is governed on a local NEAR node, through the
// bot's commands: minting a capped token, switching to a board orbit and
// back, changing the token (holders migrate), and a guard: turned on,
// confirming and rejecting, switching model behind it, replacing its
// signers after their tenure, and turning it off.
//
//   node --env-file=.env.sandbox scripts/sandbox-governance.js
//
// Needs a sandbox prepared by scripts/sandbox-setup.js with the contracts
// published (scripts/publish-contracts.js --yes).
import assert from "node:assert/strict";

const { RUN, account, link, useChat, run, advance, step, propose, pass, services } = await import("./sandbox-lib.js");
const { nearToYocto } = await import("near-api-js");
const { operatorAccount, availableBalance, view, call } = await import("../src/near/client.js");

const E18 = 10n ** 18n;
const balance = async (token, who) => BigInt(await view(token, "ft_balance_of", { account_id: account(who) })) / E18;
const stake = async (who) => BigInt((await view(link().stakingId, "get_member", { account_id: account(who) }))?.stake ?? 0) / E18;
const governing = async () => (await view(link().daoId, "get_policy")).roles.find((r) => r.name === "governance").kind.Group;
const userAccount = (who) => services.wallets.getOrCreateUserAccount("telegram", `${RUN}${who}`);
/** Behind a guard: alice and bob pass proposal `id`, and executing it hands it to the guard. */
async function passToGuard(id, voters = [1, 2]) {
  for (const u of voters) await run(u, `vote ${id} for`);
  await advance(2.5);
  return run(3, `execute ${id}`, { expect: /went to the guard/ });
}
/** A change of governance proposed by `user` (default alice); returns its number. */
const proposeChange = async (line, expect, user = 1) => Number(/\*#(\d+)\*/.exec((await run(user, line, { expect })).text)[1]);

useChat(-3001);

step("A DAO whose token can grow to 1.5M, by proposal: 1M minted now");
await run(1, `createdao gov${RUN} GOV 1000000 1500000 tokenWeighted`, { expect: /DAO can mint up to 1500000 in all/ });
for (const u of [2, 3, 4]) await run(u, "wallet", { expect: /Your account/ });
for (const [u, amount] of [[2, 300000], [3, 250000], [4, 150000]]) await run(1, `send ${amount} GOV ${account(u)}`);
for (const [u, amount] of [[1, 250000], [2, 250000], [3, 200000]]) await run(u, `stake ${amount}`);
await operatorAccount().transfer({ receiverId: link().daoId, amount: nearToYocto("10") });
await advance(0.1);

step("Minting: 300k to dave by proposal; burned tokens never free room under the cap");
await pass(await propose(`mint 300000 ${account(4)} contributor grants`));
assert.equal(await balance(link().tokenId, 4), 450000n);
await call(await userAccount(4), link().tokenId, "burn", { amount: String(100000n * E18) }, { deposit: 1n });
const supply = await view(link().tokenId, "get_supply");
assert.deepEqual([BigInt(supply.total_supply) / E18, BigInt(supply.total_minted) / E18, BigInt(supply.mintable) / E18], [1200000n, 1300000n, 200000n]);
await run(1, `mint 250000 ${account(1)} more`, { expect: /Only 200000 GOV more can ever be minted/ });
console.log("  ✔ 1.3M minted in all, 100k burned: 200k can still be minted, not 300k");

step("To a board orbit: alice, bob and carol; then the board pays and changes its members");
await pass(await proposeChange(`switchmodel board ${account(1)} ${account(2)} ${account(3)}`, /Proposed switching to \*board\*/));
assert.equal(link().model, "board");
assert.deepEqual(await governing(), [link().orbitId]);
const before = await availableBalance(account(4));
await pass(await propose(`pay 1 NEAR ${account(4)} board payout`), [1, 2]);
assert.ok((await availableBalance(account(4))) - before >= nearToYocto("0.99"));
await run(4, "vote 0 for", { expect: /Only council members vote|council members/ });
await pass(await propose(`setboard 2 ${account(1)} ${account(2)} ${account(4)}`), [1, 2]);
assert.deepEqual(await view(link().orbitId, "get_council"), [account(1), account(2), account(4)]);
console.log("  ✔ one member one vote; dave, not a member, couldn't vote; the DAO replaced carol with dave");

step("Back from the board to token voting: the stakes are still there");
await pass(await proposeChange("switchmodel tokenWeighted", /Proposed switching/), [1, 2]);
assert.equal(link().model, "tokenWeighted");
assert.equal(await stake(1), 250000n);
await pass(await propose(`signal Stakes carried over the board`));
console.log("  ✔ the board handed back to a token-weighted orbit, and old stakes vote");

step("Token change: GOV becomes NOVA at 2:1; holders migrate, staked for them");
const oldToken = link().tokenId;
await pass(await proposeChange("changetoken NOVA 2", /Proposed moving to \*NOVA\*/));
assert.notEqual(link().tokenId, oldToken);
assert.equal((await view(link().tokenId, "ft_metadata")).symbol, "NOVA");
await run(1, "migrate all", { expect: /Swapped your GOV \(your old stake included\) for 600000 NOVA, staked/ });
await run(2, "migrate all", { expect: /for 600000 NOVA, staked/ });
await run(3, "migrate 50000 keep", { expect: /for 100000 NOVA\./ });
assert.equal(await stake(1), 600000n);
assert.equal(await balance(link().tokenId, 3), 100000n);
assert.equal(await balance(oldToken, 1), 0n);
await advance(0.1);
const novaVote = await propose(`signal NOVA holders decide now`);
await pass(novaVote, [1, 2]);
console.log("  ✔ old stake unstaked and swapped in one command; NOVA stakes vote on the new orbit");

step("A guard: 2 of alice, bob and carol confirm everything that passes");
await pass(await proposeChange(`guard on 2 30m ${account(1)} ${account(2)} ${account(3)}`, /Proposed a guard/), [1, 2]);
assert.ok(link().guardId, "the chat follows the guard");
assert.deepEqual(await governing(), [link().guardId]);
const guarded = await propose(`pay 1 NEAR ${account(4)} behind the guard`);
const waiting = await passToGuard(guarded);
assert.match(waiting.text, /Waiting for the guard: instruction #0, 0 of 2/);
const daveBefore = await availableBalance(account(4));
await run(1, "confirm 0", { expect: /Confirmed instruction #0/ });
await run(4, "confirm 0", { expect: /Only the guard's signers/ });
await run(2, "confirm 0", { expect: /it ran on the DAO/ });
assert.ok((await availableBalance(account(4))) - daveBefore >= nearToYocto("0.99"));
const blocked = await propose(`pay 3 NEAR ${account(4)} the signers refuse`);
await passToGuard(blocked);
await run(2, "reject 1", { expect: /Rejected instruction #1/ });
await run(3, "reject 1", { expect: /Rejected instruction #1/ });
assert.equal((await view(link().guardId, "get_instruction", { id: 1 })).state, "Rejected");
console.log("  ✔ the payout ran once 2 signers confirmed; one 2 signers rejected never ran");

step("Switching model behind the guard: the guard moves to the new orbit once signers confirm");
const guardId = link().guardId;
await passToGuard(await proposeChange("switchmodel quadratic", /Proposed switching/));
assert.equal(link().model, "tokenWeighted", "not until the signers confirm");
await run(1, "confirm 2");
await run(3, "confirm 2", { expect: /now runs \*quadratic\* governance/ });
assert.equal(link().guardId, guardId);
assert.equal((await view(guardId, "get_config")).governance, link().orbitId);
console.log("  ✔ same guard, new orbit");

step("New signers: refused during the tenure, applied after it without the old signers");
const newSigners = await propose(`signers 1 ${account(4)}`);
for (const u of [1, 2]) await run(u, `vote ${newSigners} for`);
await advance(2.5);
await run(3, `execute ${newSigners}`, { expect: /couldn't be executed/ });
await advance(21);
await run(3, `execute ${newSigners}`, { expect: /went to the guard/ });
const config = await view(guardId, "get_config");
assert.deepEqual([config.signers, config.threshold], [[account(4)], 1]);
console.log("  ✔ dave is now the only signer, with no old signer confirming it");

step("Turning the guard off: dave confirms, and the orbit runs the DAO directly again");
await passToGuard(await proposeChange("guard off", /Proposed turning the guard off/));
await run(4, "confirm 4", { expect: /guard is off/ });
assert.equal(link().guardId, undefined);
assert.deepEqual(await governing(), [link().orbitId]);
const direct = await availableBalance(account(4));
await pass(await propose(`pay 1 NEAR ${account(4)} no guard`), [1, 2]);
assert.ok((await availableBalance(account(4))) - direct >= nearToYocto("0.99"));
console.log("  ✔ paid straight from the orbit\n\nAll governance changes passed.");
