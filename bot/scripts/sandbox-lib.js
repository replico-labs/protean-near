// Shared by the sandbox scripts (sandbox-flow.js, sandbox-models.js): the
// bot's real services with only the chat links and keys kept in memory, and
// helpers to run commands as chat users and move the sandbox's clock.
import assert from "node:assert/strict";

process.env.VOTING_PERIOD_MINUTES ??= "1";
process.env.TIMELOCK_MINUTES ??= "1";
if (process.env.NEAR_NETWORK !== "sandbox") throw new Error("Run with --env-file=.env.sandbox");

const { KeyPair, nearToYocto, yoctoToNear } = await import("near-api-js");
const { RPC_URL } = await import("../src/config.js");
const { runCommand } = await import("../src/platforms/commands.js");
const { services } = await import("../src/platforms/services.js");
const { operatorAccount, signingAccount, availableBalance } = await import("../src/near/client.js");
const { ensureGas, gasHoldNear, userAccountId } = await import("../src/near/wallets.js");

export { services };

const links = {};
const keys = {};
Object.assign(services, {
  isWalletStoreConfigured: () => true,
  db: {
    getChatDao: (platform, chatId) => links[`${platform}:${chatId}`] ?? null,
    setChatDao: (platform, chatId, link) => (links[`${platform}:${chatId}`] = link),
    removeChatDao: (platform, chatId) => delete links[`${platform}:${chatId}`],
    chatsOn: (platform) => Object.entries(links).filter(([k]) => k.startsWith(`${platform}:`)).map(([k, l]) => [k.split(":")[1], l]),
  },
  wallets: {
    async getOrCreateUserAccount(platform, userId) {
      const accountId = userAccountId(platform, userId);
      if (!keys[accountId]) {
        keys[accountId] = KeyPair.fromRandom("ed25519");
        // 1 NEAR, so users can spend some (decision markets). SANDBOX_USER_NEAR=0.05 starts them as on
        // testnet (NEW_ACCOUNT_NEAR), with only ensureGas's top-ups to pay for their calls.
        await operatorAccount().createSubAccount({ accountOrPrefix: accountId, publicKey: keys[accountId].getPublicKey().toString(), nearToTransfer: nearToYocto(process.env.SANDBOX_USER_NEAR ?? "1") });
      }
      return signingAccount(accountId, keys[accountId].toString());
    },
    ensureGas,
    gasHoldNear,
    findUserAccountId: async (platform, userId) => (keys[userAccountId(platform, userId)] ? userAccountId(platform, userId) : null),
    availableBalance,
  },
});

/** Each run gets new users and DAO names: the sandbox keeps accounts, but keys here live in memory. */
export const RUN = String(Date.now() % 1_000_000);
const NAMES = ["", "alice", "bob", "carol", "dave", "erin"];
const tgId = (user) => `${RUN}${user}`;
/** User `n`'s NEAR account (1 alice ... 5 erin). */
export const account = (user) => userAccountId("telegram", tgId(user));

let chat = "-1001";
/** Commands go to chat `id` from now on; each DAO can have its own. */
export const useChat = (id) => (chat = String(id));
/** The current chat's DAO link. */
export const link = () => links[`telegram:${chat}`];

/** Runs `/name args...` as user `user` in the current chat; fails on a refusal unless `expect` says otherwise. */
export async function run(user, line, { expect } = {}) {
  const [name, ...args] = line.trim().split(/\s+/);
  const reply = await runCommand(name, { platform: "telegram", chatId: chat, userId: tgId(user), args, isAdmin: true, cmd: (n) => `/${n}` });
  console.log(`  ${NAMES[user]}: /${line}\n    → ${reply.text.split("\n").join("\n      ")}`);
  if (expect) assert.match(reply.text, expect, `/${line}`);
  else assert.ok(!reply.ephemeral, `/${line} was refused: ${reply.text}`);
  return reply;
}

export async function rpc(method, params) {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

const height = async (finality) => (await rpc("block", { finality })).header.height;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Blocks per fast-forward call. The node answers only once it has made them
// all, and a long jump on a slower machine outlasts fetch's 5-minute wait.
const FAST_FORWARD_STEP = 300;

/** Moves the sandbox's clock forward about `minutes`. */
export async function advance(minutes) {
  const target = (await height("optimistic")) + Math.ceil(minutes * 60);
  for (let h = await height("optimistic"); h < target; h = await height("optimistic")) {
    try {
      await rpc("sandbox_fast_forward", { delta_height: Math.min(target - h, FAST_FORWARD_STEP) });
    } catch (err) {
      // The node keeps fast-forwarding after the request gives up; wait for it.
      if (!/fetch failed|timeout/i.test(`${err.message} ${err.cause?.code ?? ""}`)) throw err;
      await sleep(5000);
    }
  }
  // Transactions reference a final block; wait until finality catches up with the jump.
  const top = await height("optimistic");
  while ((await height("final")) < top) await sleep(300);
  console.log(`  ⏩ ${minutes} minute(s) later`);
}

export const step = (title) => console.log(`\n== ${title}`);
export const near = (yocto) => `${yoctoToNear(yocto)} NEAR`;
/** The proposal number in a reply ("*#3* — ..."). */
export const proposalId = (reply) => Number(/\*#(\d+)\*/.exec(reply.text)[1]);

/** `user` (default alice) proposes with `line`; returns the new proposal's number. */
export async function propose(line, user = 1) {
  return proposalId(await run(user, line, { expect: /New proposal/ }));
}

/** `voters` vote for proposal `id`, the clock passes its vote and timelock, and carol executes it. */
export async function pass(id, voters = [1, 2, 3]) {
  for (const u of voters) await run(u, `vote ${id} for`);
  await advance(2.5);
  return run(3, `execute ${id}`, { expect: /executed/i });
}
