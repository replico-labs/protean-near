import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/platforms/commands.js";
import { services } from "../src/platforms/services.js";
import { ChainError } from "../src/near/client.js";

const DAO = "mydao.sputnikv2.testnet";
const ORBIT = "tw.mydao.orbits.testnet";
const TOKEN = "token.mydao.orbits.testnet";
const STAKING = "staking.mydao.orbits.testnet";
const E18 = 10n ** 18n;

/** A fake chain and chat store; `calls` records every write. */
let calls;
let links;
let proposals;

beforeEach(() => {
  calls = [];
  links = {};
  proposals = [];
  const account = { accountId: "tg42.orbits.testnet" };
  Object.assign(services, {
    isWalletStoreConfigured: () => true,
    db: {
      getChatDao: (p, c) => links[`${p}:${c}`] ?? null,
      setChatDao: (p, c, l) => (links[`${p}:${c}`] = l),
      removeChatDao: (p, c) => delete links[`${p}:${c}`],
    },
    wallets: {
      getOrCreateUserAccount: async () => account,
      ensureGas: async () => {},
      availableBalance: async () => 5n * 10n ** 24n,
    },
    core: {
      governingOrbits: async (dao) => (dao === DAO ? [ORBIT] : []),
      treasuryNear: async () => 12n * 10n ** 24n,
      getCoreProposal: async () => ({ status: "Approved" }),
    },
    tokenWeight: {
      getDao: async (orbit) => {
        if (orbit === ORBIT || orbit === "q.mydao.orbits.testnet") return DAO;
        throw new Error("no contract");
      },
      getStakingContract: async () => STAKING,
      getToken: async () => TOKEN,
      tokenMetadata: async () => ({ symbol: "ARK", decimals: 18 }),
      tokenBalance: async () => 100n * E18,
      weightOf: async () => 40n * E18,
      totalWeight: async () => 100n * E18,
      getThreshold: async () => 51n * E18,
      getConfig: async () => ({ threshold: [1, 2], quorum: "0", voting_period: String(86_400n * 10n ** 9n), min_proposer_weight: "0" }),
      stakingUser: async () => ({ vote_amount: String(40n * E18), delegated_amounts: [[account.accountId, String(40n * E18)]], next_action_timestamp: "0" }),
      getProposalCount: async () => proposals.length,
      getProposals: async (o, from, limit) => proposals.slice(from, from + limit),
      getProposal: async (o, id) => proposals[id] ?? null,
      propose: async (acct, orbit, description, kind) => {
        calls.push(["propose", orbit, description, kind]);
        proposals.push({ id: proposals.length, description, kind, status: "InProgress", approve: "0", reject: "0", voters: 0, voting_ends: "0", core_proposal_id: null, sending: false });
        return proposals.length - 1;
      },
      vote: async (acct, orbit, id, choice) => {
        calls.push(["vote", id, choice]);
        if (choice === "Reject") throw new ChainError(new Error("Smart contract panicked: ERR_ALREADY_VOTED"));
        proposals[id].status = "Passed";
        proposals[id].sending = true;
        return "Passed";
      },
      stake: async (acct, token, staking, amount) => calls.push(["stake", token, staking, amount]),
    },
  });
});

const ctx = (args = [], extra = {}) => ({ platform: "telegram", chatId: "-100", userId: "42", args, isAdmin: true, cmd: (n) => `/${n}`, ...extra });
const linked = () => (links["telegram:-100"] = { daoId: DAO, orbitId: ORBIT, orbitType: "tokenWeight", tokenId: TOKEN, stakingId: STAKING });

test("link checks the orbit governs the DAO, then stores both", async () => {
  const r = await runCommand("link", ctx([DAO, ORBIT]));
  assert.match(r.text, /Linked/);
  assert.deepEqual(links["telegram:-100"], { daoId: DAO, orbitId: ORBIT, orbitType: "tokenWeight", tokenId: TOKEN, stakingId: STAKING, linkedBy: "42" });
});

test("link refuses an orbit bound elsewhere and a non-orbit", async () => {
  assert.match((await runCommand("link", ctx(["other.sputnikv2.testnet", ORBIT]))).text, /governs `mydao/);
  assert.match((await runCommand("link", ctx([DAO, "nobody.testnet"]))).text, /isn't a token-weight orbit/);
  assert.equal(links["telegram:-100"], undefined);
});

test("only admins link in a group", async () => {
  const r = await runCommand("link", ctx([DAO, ORBIT], { isAdmin: false }));
  assert.match(r.text, /Only this chat's admins/);
  assert.equal(r.ephemeral, true);
});

test("commands need a linked DAO", async () => {
  assert.match((await runCommand("proposals", ctx())).text, /isn't linked to a DAO/);
});

test("pay in NEAR proposes a transfer in yoctoNEAR", async () => {
  linked();
  const r = await runCommand("pay", ctx(["1.5", "near", "maya.testnet", "logo", "design"]));
  assert.deepEqual(calls[0], ["propose", ORBIT, "logo design", { Transfer: { token_id: "", receiver_id: "maya.testnet", amount: "1500000000000000000000000" } }]);
  assert.match(r.text, /Pay 1\.5 NEAR to maya\.testnet/);
  assert.deepEqual(r.buttons[0].map((b) => b.cmd), ["vote 0 for", "vote 0 against"]);
});

test("pay in the DAO token uses its decimals", async () => {
  linked();
  await runCommand("pay", ctx(["250", "ARK", "maya.testnet", "bounty"]));
  assert.deepEqual(calls[0][3], { Transfer: { token_id: TOKEN, receiver_id: "maya.testnet", amount: String(250n * E18) } });
});

test("pay refuses bad input before touching the chain", async () => {
  linked();
  for (const args of [["x", "NEAR", "maya.testnet", "a"], ["1", "BTC", "maya.testnet", "a"], ["1", "NEAR", "Not An Account", "a"], ["1", "NEAR", "maya.testnet"]]) {
    const r = await runCommand("pay", ctx(args));
    assert.equal(r.ephemeral, true, args.join(" "));
  }
  assert.equal(calls.length, 0);
});

test("swap only to an orbit already bound to this DAO", async () => {
  linked();
  assert.match((await runCommand("swap", ctx(["stranger.testnet", "why"]))).text, /isn't an orbit bound/);
  await runCommand("swap", ctx(["q.mydao.orbits.testnet", "move", "to", "quadratic"]));
  assert.equal(calls[0][3].ChangePolicyAddOrUpdateRole.role.kind.Group[0], "q.mydao.orbits.testnet");
});

test("vote maps for/against and reports a pass", async () => {
  linked();
  await runCommand("signal", ctx(["Adopt", "the", "charter?"]));
  const r = await runCommand("vote", ctx(["0", "FOR"]));
  assert.deepEqual(calls[1], ["vote", 0, "Approve"]);
  assert.match(r.text, /passed and is being executed/);
});

test("contract errors come back in words", async () => {
  linked();
  await runCommand("signal", ctx(["Adopt?"]));
  const r = await runCommand("vote", ctx(["0", "against"]));
  assert.equal(r.text, "You've already voted on this proposal.");
  assert.equal(r.ephemeral, true);
});

test("stake checks the balance, then stakes token units", async () => {
  linked();
  assert.match((await runCommand("stake", ctx(["1000"]))).text, /You have 100 ARK/);
  const r = await runCommand("stake", ctx(["2.5"]));
  assert.deepEqual(calls.at(-1), ["stake", TOKEN, STAKING, 25n * E18 / 10n]);
  assert.match(r.text, /voting weight is now 40/);
});

test("wallet shows balances privately", async () => {
  linked();
  const r = await runCommand("wallet", ctx());
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /tg42\.orbits\.testnet/);
  assert.match(r.text, /Voting weight: 40 ARK/);
});

test("dao and help describe the chat", async () => {
  linked();
  const dao = await runCommand("dao", ctx());
  assert.match(dao.text, /more than 1\/2 of staked weight — now 51 ARK/);
  assert.match(dao.text, /Voting period: 24 hours/);
  const help = await runCommand("help", ctx(["all"]));
  assert.match(help.text, /\/pay <amount>/);
});
