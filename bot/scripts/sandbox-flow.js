// Runs Protean end to end on a local NEAR node, through the bot's own
// commands: the same code a Telegram or Discord message runs, with only the
// chat and the key store replaced by in-memory ones. Every contract call,
// account and DAO is real.
//
//   node --env-file=.env.sandbox scripts/sandbox-flow.js
//
// Needs a running near-sandbox prepared by scripts/sandbox-setup.js, and the
// contracts published there (scripts/publish-contracts.js --yes).
// Voting periods are a minute; the script moves the sandbox's clock forward
// instead of waiting.
import assert from "node:assert/strict";

process.env.VOTING_PERIOD_MINUTES ??= "1";
process.env.TIMELOCK_MINUTES ??= "1";
if (process.env.NEAR_NETWORK !== "sandbox") throw new Error("Run with --env-file=.env.sandbox");

const { KeyPair, nearToYocto, yoctoToNear } = await import("near-api-js");
const { RPC_URL, OPERATOR_ACCOUNT_ID } = await import("../src/config.js");
const { runCommand } = await import("../src/platforms/commands.js");
const { services } = await import("../src/platforms/services.js");
const { operatorAccount, signingAccount, accountExists, availableBalance, view, call } = await import("../src/near/client.js");
const { ensureGas, userAccountId } = await import("../src/near/wallets.js");
const deploy = await import("../src/near/deploy.js");
const { modelConfig, MODULE_CONTRACT } = await import("../src/near/models.js");

const E18 = 10n ** 18n;
const CHAT = "-1001";

// --- In-memory chat links and keys; everything else is the bot's real services ---

const links = {};
const keys = {};
Object.assign(services, {
  isWalletStoreConfigured: () => true,
  db: {
    getChatDao: (platform, chatId) => links[`${platform}:${chatId}`] ?? null,
    setChatDao: (platform, chatId, link) => (links[`${platform}:${chatId}`] = link),
    removeChatDao: (platform, chatId) => delete links[`${platform}:${chatId}`],
  },
  wallets: {
    async getOrCreateUserAccount(platform, userId) {
      const accountId = userAccountId(platform, userId);
      if (!keys[accountId]) {
        keys[accountId] = KeyPair.fromRandom("ed25519");
        await operatorAccount().createSubAccount({ accountOrPrefix: accountId, publicKey: keys[accountId].getPublicKey().toString(), nearToTransfer: nearToYocto("1") });
      }
      return signingAccount(accountId, keys[accountId].toString());
    },
    ensureGas,
    findUserAccountId: async (platform, userId) => (keys[userAccountId(platform, userId)] ? userAccountId(platform, userId) : null),
    availableBalance,
  },
});

// Each run gets new users: the sandbox keeps accounts, but keys here live in memory.
const RUN = String(Date.now() % 1_000_000);
const tgId = (user) => `${RUN}${user}`;

/** Runs `/name args...` as user 1, 2 or 3 in the test chat; fails on a refusal unless `expect` says otherwise. */
async function run(userId, line, { expect } = {}) {
  const [name, ...args] = line.split(/\s+/);
  const reply = await runCommand(name, { platform: "telegram", chatId: CHAT, userId: tgId(userId), args, isAdmin: true, cmd: (n) => `/${n}` });
  console.log(`  ${userName[userId]}: /${line}\n    → ${reply.text.split("\n").join("\n      ")}`);
  if (expect) assert.match(reply.text, expect, `/${line}`);
  else assert.ok(!reply.ephemeral, `/${line} was refused: ${reply.text}`);
  return reply;
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

/** Moves the sandbox's clock forward about `minutes`. */
async function advance(minutes) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sandbox_fast_forward", params: { delta_height: Math.ceil(minutes * 60) } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  // Transactions reference a final block; wait until finality catches up with the jump.
  const height = async (finality) => (await rpc("block", { finality })).header.height;
  const target = await height("optimistic");
  while ((await height("final")) < target) await new Promise((r) => setTimeout(r, 300));
  console.log(`  ⏩ ${minutes} minute(s) later`);
}

const step = (title) => console.log(`\n== ${title}`);
const link = () => links[`telegram:${CHAT}`];
const near = (yocto) => `${yoctoToNear(yocto)} NEAR`;
const userName = { 1: "alice", 2: "bob", 3: "carol" };
const name = `ark${RUN}`;

// ---------------------------------------------------------------------------

step(`Alice creates a token-weighted DAO "${name}" from the chat`);
await run(1, `createdao ${name} ARK 1000000`, { expect: /is live/ });
const { daoId, tokenId } = link();
const alice = userAccountId("telegram", tgId(1));
const bob = userAccountId("telegram", tgId(2));
const carol = userAccountId("telegram", tgId(3));
assert.deepEqual((await view(daoId, "get_policy")).roles.find((r) => r.name === "governance").kind.Group, [link().orbitId]);
console.log(`  The core ${daoId} has one member: the orbit ${link().orbitId}`);

step("Members get tokens and stake them");
await run(2, "wallet", { expect: /Your account/ });
await run(3, "wallet", { expect: /Your account/ });
await run(1, `send 300000 ARK ${bob}`);
await run(1, `send 100000 ARK ${carol}`);
await run(1, "stake 500000");
await run(2, "stake 300000");
await run(3, "stake 100000");

step("Someone funds the treasury with 5 NEAR");
await operatorAccount().transfer({ receiverId: daoId, amount: nearToYocto("5") });
await advance(0.1);

step("A payout: propose, vote, execute");
const carolBefore = await availableBalance(carol);
await run(1, `pay 1 NEAR ${carol} first payout`, { expect: /#0\b/ });
await run(1, "vote 0 for");
await run(2, "vote 0 against");
await run(3, "vote 0 for");
await run(1, "execute 0", { expect: /hasn't|not|timelock|still/i });
await advance(2.5);
await run(2, "execute 0", { expect: /executed/i });
const carolGain = (await availableBalance(carol)) - carolBefore;
assert.ok(carolGain >= nearToYocto("0.99"), `carol got ${near(carolGain)}`);
console.log(`  ✔ carol received ${near(carolGain)} from the treasury (600k for, 300k against)`);

step("The same proposal can't execute twice");
await run(1, "execute 0", { expect: /already executed/ });

step("A model switch: token-weighted → quadratic, same treasury and stakes");
const treasuryBefore = await availableBalance(daoId);
await run(1, "switchmodel quadratic", { expect: /#1\b/ });
await run(1, "vote 1 for");
await run(2, "vote 1 for");
await advance(2.5);
await run(3, "execute 1", { expect: /now runs quadratic|executed/i });
const governing = (await view(daoId, "get_policy")).roles.find((r) => r.name === "governance").kind.Group;
assert.equal(link().model, "quadratic");
assert.deepEqual(governing, [link().orbitId]);
assert.equal((await view(link().orbitId, "get_model")).Quadratic !== undefined, true);
console.log(`  ✔ the core's only member is now ${link().orbitId} (the quadratic module); treasury ${near(treasuryBefore)} → ${near(await availableBalance(daoId))}`);

step("Quadratic: weights are square roots of the same stakes");
await advance(0.1);
await run(3, `pay 0.5 NEAR ${carol} quadratic payout`, { expect: /#0\b/ });
await run(1, "vote 0 against");
await run(2, "vote 0 for");
await run(3, "vote 0 for");
const p = await view(link().orbitId, "get_proposal", { id: 0 });
const isqrt = (x) => {
  let r = BigInt(Math.floor(Math.sqrt(Number(x))));
  while (r * r > x) r--;
  while ((r + 1n) * (r + 1n) <= x) r++;
  return r;
};
assert.equal(BigInt(p.against_votes), isqrt(500000n * E18));
assert.equal(BigInt(p.for_votes), isqrt(300000n * E18) + isqrt(100000n * E18));
console.log(`  ✔ against ${p.against_votes} (√ of alice's 500k) vs for ${p.for_votes} (√300k + √100k): bob and carol outvote alice`);
await advance(2.5);
await run(1, "execute 0", { expect: /executed/i });

step("Switch to conviction, which locks stake while it backs a proposal");
await run(2, "switchmodel conviction", { expect: /#1\b/ });
for (const u of [1, 2, 3]) await run(u, "vote 1 for");
await advance(2.5);
await run(1, "execute 1", { expect: /now runs conviction|executed/i });
assert.equal(await view(link().stakingId, "get_locker"), link().orbitId);
console.log(`  ✔ the conviction orbit is the staking contract's locker`);
await run(3, `pay 1 NEAR ${carol} conviction payout`, { expect: /#0\b/ });
await run(1, "support 0");
await run(2, "support 0");
await run(1, "unstake 1", { expect: /locked|backing|can't|cannot/i });
await advance(30);
await run(3, "queue 0", { expect: /queued/i });
await advance(2);
await run(3, "execute 0", { expect: /executed/i });
await run(1, "withdrawsupport");

step("Every module is live on chain, and each runs only its own model");
const contracts = deploy.publishedContracts("tokenWeighted");
const base = `${name}.${OPERATOR_ACCOUNT_ID}`;
const namespace = signingAccount(base, process.env.NEAR_OPERATOR_PRIVATE_KEY);
for (const [model, contract] of Object.entries(MODULE_CONTRACT)) {
  const orbitId = await deploy.createOrbit({ name, daoId, tokenId, stakingId: link().stakingId, model, supply: 1_000_000n * E18, council: [alice, bob, carol] });
  const settings = await view(orbitId, "get_model");
  assert.ok(Object.keys(settings)[0].toLowerCase() === model.toLowerCase(), `${orbitId}: ${JSON.stringify(settings).slice(0, 80)}`);
  console.log(`  ✔ ${contract.padEnd(24)} ${orbitId}`);
}
await operatorAccount().transfer({ receiverId: base, amount: nearToYocto("0.5") });
const wrong = `wrong.${base}`;
await assert.rejects(
  namespace.signAndSendTransaction({
    receiverId: wrong,
    actions: [
      (await import("near-api-js")).actions.createAccount(),
      (await import("near-api-js")).actions.transfer(nearToYocto("0.2")),
      (await import("near-api-js")).actions.useGlobalContract({ codeHash: contracts.orbit_token_weighted.codeHashHex }),
      (await import("near-api-js")).actions.functionCall("new", { dao_id: daoId, staking_id: link().stakingId, token_id: tokenId, model: modelConfig("quadratic", 10n ** 24n), council: null }, 100_000_000_000_000n, 0n),
    ],
  }),
  /ERR_MODEL/,
);
assert.equal(await accountExists(wrong), false);
console.log("  ✔ the token-weighted module refuses quadratic settings, and nothing is created");

step("A board DAO: Sputnik's own multisig, no orbit");
await run(1, "unlink", { expect: /unlinked|no longer/i });
await run(1, `createdao ${name}b BRD 1000 board ${alice} ${bob} ${carol}`, { expect: /is live/ });
await operatorAccount().transfer({ receiverId: link().daoId, amount: nearToYocto("2") });
await run(1, `pay 1 NEAR ${carol} board payout`, { expect: /#0\b/ });
await run(1, "vote 0 for");
await run(2, "vote 0 for", { expect: /executed|approved|passed/i });
const proposal = await view(link().daoId, "get_proposal", { id: 0 });
assert.equal(proposal.status, "Approved");
console.log("  ✔ two of three board members approved and Sputnik paid out");

console.log("\nAll checks passed.");
