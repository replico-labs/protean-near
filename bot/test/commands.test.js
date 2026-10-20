import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand, COMMANDS } from "../src/platforms/commands.js";
import { services } from "../src/platforms/services.js";
import { ChainError } from "../src/near/client.js";

const DAO = "ark.sputnikv2.testnet";
const BASE = "ark.orbits.testnet";
const ORBIT = `tw.${BASE}`;
const TOKEN = `token.${BASE}`;
const STAKING = `staking.${BASE}`;
const ME = "tg42.orbits.testnet";
const E18 = 10n ** 18n;
const chainError = (code) => new ChainError(new Error(`Smart contract panicked: ${code}`));

/** A fake chain and chat store. `calls` records every write; `state` drives the fakes. */
let calls, links, state;

const modelSettings = {
  tokenWeighted: { TokenWeighted: { quorum_bps: 2000, approval_bps: 5000, voting_delay: "0", voting_period: "3600000000000", timelock: "60000000000", execution_period: "1", proposal_threshold: "0" } },
  optimistic: { Optimistic: { rules: {}, challenge_period: "3600000000000", challenge_bond: String(1000n * E18) } },
  conviction: { Conviction: {} },
  delegate: { Delegate: { candidacy_threshold: String(10n * E18) } },
  sortition: { Sortition: { eligibility_threshold: String(E18) } },
  sowellian: { Sowellian: { proposal_bond: String(100n * E18), resolution_bond: String(50n * E18), challenge_bond: String(50n * E18) } },
  decisionMarkets: { DecisionMarkets: { trading_period: "3600000000000", threshold_bps: 100 } },
};

beforeEach(() => {
  calls = [];
  links = {};
  state = { proposals: [], coreProposals: [], governing: { [DAO]: [ORBIT] }, models: { [ORBIT]: modelSettings.tokenWeighted }, balance: 100n * E18 };
  const account = { accountId: ME, transfer: async (a) => calls.push(["transfer", a.receiverId, a.amount]) };
  const record = (name) => async (...args) => {
    calls.push([name, ...args.slice(1)]);
  };
  Object.assign(services, {
    isWalletStoreConfigured: () => true,
    db: {
      getChatDao: (p, c) => links[`${p}:${c}`] ?? null,
      setChatDao: (p, c, l) => (links[`${p}:${c}`] = l),
      removeChatDao: (p, c) => delete links[`${p}:${c}`],
    },
    wallets: { getOrCreateUserAccount: async () => account, ensureGas: async () => {}, availableBalance: async () => 5n * 10n ** 24n },
    deploy: {
      daoAccounts: (name) => ({ base: `${name}.orbits.testnet`, dao: `${name}.sputnikv2.testnet`, token: `token.${name}.orbits.testnet`, staking: `staking.${name}.orbits.testnet` }),
      createDao: async (args) => {
        calls.push(["createDao", args]);
        return { daoId: DAO, orbitId: args.model === "board" ? null : ORBIT, tokenId: TOKEN, stakingId: STAKING, model: args.model };
      },
      createOrbit: async (args) => {
        calls.push(["createOrbit", args]);
        return `qv.${BASE}`;
      },
    },
    core: {
      governingMembers: async (dao) => {
        if (!state.governing[dao]) throw new Error("no such DAO");
        return state.governing[dao];
      },
      treasuryNear: async () => 12n * 10n ** 24n,
      getCoreProposal: async (dao, id) => state.coreProposals[id] ?? null,
      getCoreProposals: async (dao, from, limit) => state.coreProposals.slice(from, from + limit),
      getLastProposalId: async () => state.coreProposals.length,
      addProposal: async (acct, dao, description, kind) => {
        calls.push(["addProposal", description, kind]);
        state.coreProposals.push({ id: state.coreProposals.length, description, kind, status: "InProgress", vote_counts: {} });
        return state.coreProposals.length - 1;
      },
      actProposal: async (acct, dao, id, action) => {
        calls.push(["actProposal", id, action]);
        if (action === "VoteApprove") state.coreProposals[id].status = "Approved";
      },
    },
    staking: {
      tokenMetadata: async (id) => {
        if (!id.startsWith("token.")) throw new Error("not a token");
        return { symbol: "ARK", decimals: 18 };
      },
      tokenBalance: async () => state.balance,
      totalSupply: async () => 1_000_000n * E18,
      totalStaked: async () => 400n * E18,
      getMember: async () => ({ stake: 40n * E18, locked: 0n, available: 40n * E18, storage: 10n ** 22n }),
      stake: record("stake"),
      unstake: async (acct, staking, amount) => {
        calls.push(["unstake", amount]);
        if (amount > 40n * E18) throw chainError("ERR_NOT_ENOUGH_UNLOCKED_STAKE");
      },
      sendToken: record("sendToken"),
    },
    orbit: {
      modelOf: (m) => {
        const [name, settings] = Object.entries(m)[0];
        return { name: name[0].toLowerCase() + name.slice(1), settings };
      },
      getModel: async (orbit) => state.models[orbit],
      getDao: async (orbit) => {
        if (!state.models[orbit]) throw new Error("no contract");
        return DAO;
      },
      getStakingContract: async () => STAKING,
      getToken: async () => TOKEN,
      getProposalCount: async () => state.proposals.length,
      getProposals: async (o, from, limit) => state.proposals.slice(from, from + limit),
      getProposal: async (o, id) => state.proposals[id] ?? null,
      propose: async (acct, orbit, description, kind) => {
        calls.push(["propose", orbit, description, kind]);
        state.proposals.push({ id: state.proposals.length, description, kind, state: "Active", for_votes: "0", against_votes: "0", abstain_votes: "0", voters: 0, start: "0", end: "0", conviction: "0", support: "0", required_conviction: "0" });
        return state.proposals.length - 1;
      },
      vote: async (acct, orbit, id, choice) => {
        calls.push(["vote", id, choice]);
        if (state.noStake) return { counted: false, weight: "0", state: "Active" };
        return { counted: true, weight: "40", state: "Active" };
      },
      execute: async (acct, orbit, id) => {
        calls.push(["execute", id]);
        state.proposals[id].state = "Executed";
        const target = state.proposals[id].kind?.ChangePolicyAddOrUpdateRole?.role?.kind?.Group?.[0];
        if (target) state.governing[DAO] = [target];
      },
      challenge: record("challenge"),
      support: async () => (state.noStake ? "0" : String(40n * E18)),
      claimLocker: record("claimLocker"),
      getCouncil: async () => ["c1.testnet"],
      getTermEnd: async () => "0",
      getElectionCount: async () => 1,
      getElection: async () => [{ finalized: false, candidacy_end: "0", voting_end: "0" }, [["c1.testnet", "5"]]],
      voteInElection: async (acct, orbit, id, candidates) => {
        calls.push(["voteInElection", id, candidates]);
        return "40";
      },
      getPool: async () => [],
      proposeWithCriteria: async (acct, orbit, description, kind, period) => {
        calls.push(["proposeWithCriteria", description, kind, period]);
        state.proposals.push({ id: state.proposals.length, description, kind, state: "Pending", for_votes: "0", against_votes: "0", abstain_votes: "0", voters: 0, start: "0", end: "0" });
        return state.proposals.length - 1;
      },
      sendToOrbit: async (acct, token, orbit, amount, msg) => {
        calls.push(["sendToOrbit", amount, msg]);
        if (msg.position !== undefined) state.position = { yes: msg.side === "Yes" ? String(amount) : "0", no: msg.side === "No" ? String(amount) : "0" };
      },
      getPosition: async () => state.position ?? null,
      getBet: async () => ({ yes_pool: "0", no_pool: "0", criteria: "Human" }),
      getExchange: async () => [{ opened_at: null, token_seed: "0", near_seed: "0" }, "0", "0"],
      seedNear: async (acct, orbit, id, amount) => calls.push(["seedNear", id, amount]),
      trade: async (acct, orbit, id, side, asset, amount) => {
        calls.push(["trade", id, side, asset, amount]);
        if (amount > 10n ** 24n) throw chainError("ERR_NOT_ENOUGH_UNITS");
        return String(7n * E18);
      },
    },
  });
});

const ctx = (args = [], extra = {}) => ({ platform: "telegram", chatId: "-100", userId: "42", args, isAdmin: true, cmd: (n) => `/${n}`, ...extra });
const linked = (model = "tokenWeighted", orbitId = ORBIT) => {
  links["telegram:-100"] = { daoId: DAO, orbitId: model === "board" ? null : orbitId, model, tokenId: TOKEN, stakingId: STAKING, name: "ark" };
  if (model !== "board") state.models[orbitId] = modelSettings[model] ?? modelSettings.tokenWeighted;
  else state.governing[DAO] = [ME, "bob.testnet"];
};

test("createdao deploys with the caller as holder and links the chat", async () => {
  const r = await runCommand("createdao", ctx(["ark", "ark", "1000000", "quadratic"]));
  assert.match(r.text, /is live, with \*quadratic\* governance/);
  const [, args] = calls[0];
  assert.deepEqual({ ...args, onStep: undefined }, { name: "ark", symbol: "ARK", supply: 1_000_000n * E18, model: "quadratic", council: [], holder: ME, onStep: undefined });
  assert.equal(links["telegram:-100"].model, "quadratic");
});

test("createdao checks its input and who may run it", async () => {
  assert.match((await runCommand("createdao", ctx(["Ark!", "ARK", "1"]))).text, /lowercase/);
  assert.match((await runCommand("createdao", ctx(["ark", "ARK", "1", "plutocracy"]))).text, /Unknown model/);
  assert.match((await runCommand("createdao", ctx(["ark", "ARK", "1", "board"]))).text, /needs its members/);
  assert.match((await runCommand("createdao", ctx(["ark", "ARK", "1", "quadratic", "me"]))).text, /Only board, delegate and sortition/);
  assert.match((await runCommand("createdao", ctx(["ark", "ARK", "1"], { isAdmin: false }))).text, /Only this chat's admins/);
  assert.equal(calls.length, 0);
});

test("a board takes members, with me as the caller", async () => {
  await runCommand("createdao", ctx(["ark", "ARK", "1000", "board", "me", "bob.testnet"]));
  assert.deepEqual(calls[0][1].council, [ME, "bob.testnet"]);
});

test("link checks the orbit governs the DAO", async () => {
  state.models[ORBIT] = modelSettings.tokenWeighted;
  assert.match((await runCommand("link", ctx([DAO, "nobody.testnet"]))).text, /isn't an orbit/);
  const r = await runCommand("link", ctx([DAO, ORBIT]));
  assert.match(r.text, /Linked to `ark\.sputnikv2\.testnet`, governed by `tw\.ark\.orbits\.testnet` \(\*tokenWeighted\*\)/);
});

test("link finds a board's token by its standard name", async () => {
  state.governing[DAO] = [ME, "bob.testnet"];
  const r = await runCommand("link", ctx([DAO]));
  assert.match(r.text, /board DAO/);
  assert.equal(links["telegram:-100"].tokenId, TOKEN);
});

test("pay proposes through the orbit, in NEAR or the token", async () => {
  linked();
  await runCommand("pay", ctx(["1.5", "near", "maya.testnet", "logo"]));
  assert.deepEqual(calls[0], ["propose", ORBIT, "logo", { Transfer: { token_id: "", receiver_id: "maya.testnet", amount: "1500000000000000000000000" } }]);
  const r = await runCommand("pay", ctx(["250", "ARK", "me", "bounty"]));
  assert.deepEqual(calls[1][3], { Transfer: { token_id: TOKEN, receiver_id: ME, amount: String(250n * E18) } });
  assert.deepEqual(r.buttons[0].map((b) => b.cmd), ["vote 1 for", "vote 1 against", "vote 1 abstain"]);
});

test("a board proposes and votes on the DAO directly; approval executes", async () => {
  linked("board");
  await runCommand("signal", ctx(["Adopt", "the", "charter?"]));
  assert.deepEqual(calls[0], ["addProposal", "Adopt the charter?", "Vote"]);
  const r = await runCommand("vote", ctx(["0", "for"]));
  assert.deepEqual(calls[1], ["actProposal", 0, "VoteApprove"]);
  assert.match(r.text, /It passed and was executed/);
});

test("a vote without stake at the snapshot is explained", async () => {
  linked();
  await runCommand("signal", ctx(["Q?"]));
  state.noStake = true;
  assert.match((await runCommand("vote", ctx(["0", "for"]))).text, /no stake when this proposal was made/);
});

test("model-specific commands refuse other models", async () => {
  linked("tokenWeighted");
  assert.match((await runCommand("support", ctx(["0"]))).text, /for conviction DAOs; this chat's DAO is \*tokenWeighted\*/);
  assert.match((await runCommand("draw", ctx())).text, /for sortition DAOs/);
});

test("help lists only what applies to the chat's model", async () => {
  linked("conviction");
  const text = (await runCommand("help", ctx(["all"]))).text;
  assert.match(text, /\/support <id>/);
  assert.doesNotMatch(text, /\/vote <id>/);
  assert.doesNotMatch(text, /\/startelection/);
});

test("switchmodel creates the new orbit and proposes the swap; execute moves the chat", async () => {
  linked();
  state.models[`qv.${BASE}`] = { Quadratic: {} };
  const r = await runCommand("switchmodel", ctx(["quadratic"]));
  assert.equal(calls[0][0], "createOrbit");
  assert.equal(calls[0][1].model, "quadratic");
  assert.equal(calls[1][3].ChangePolicyAddOrUpdateRole.role.kind.Group[0], `qv.${BASE}`);
  assert.match(r.text, /Proposed switching to \*quadratic\*/);
  state.proposals[0].state = "Succeeded";
  const done = await runCommand("execute", ctx(["0"]));
  assert.match(done.text, /now runs \*quadratic\* governance/);
  assert.equal(links["telegram:-100"].orbitId, `qv.${BASE}`);
  assert.equal(links["telegram:-100"].model, "quadratic");
});

test("switching to conviction makes the new orbit the locker", async () => {
  linked();
  state.models[`qv.${BASE}`] = { Conviction: {} };
  await runCommand("switchmodel", ctx(["conviction"]));
  await runCommand("execute", ctx(["0"]));
  assert.ok(calls.some(([name]) => name === "claimLocker"));
});

test("challenge needs the bond in hand", async () => {
  linked("optimistic");
  state.balance = 10n * E18;
  assert.match((await runCommand("challenge", ctx(["0"]))).text, /takes a 1000 ARK bond; you have 10 ARK/);
});

test("support without unlocked stake is explained", async () => {
  linked("conviction");
  await runCommand("signal", ctx(["Q?"]));
  state.noStake = true;
  assert.match((await runCommand("support", ctx(["0"]))).text, /no unlocked stake/);
});

test("election votes take candidate accounts", async () => {
  linked("delegate");
  const r = await runCommand("voteinelection", ctx(["c1.testnet", "me"]));
  assert.deepEqual(calls[0], ["voteInElection", 0, ["c1.testnet", ME]]);
  assert.match(r.text, /Voted for `c1\.testnet`, `tg42\.orbits\.testnet`/);
});

test("unstake explains locked stake", async () => {
  linked("conviction");
  assert.match((await runCommand("unstake", ctx(["50"]))).text, /locked; `\/withdrawsupport` releases it/);
});

test("send moves tokens or NEAR", async () => {
  linked();
  await runCommand("send", ctx(["5", "ARK", "bob.testnet"]));
  assert.deepEqual(calls[0], ["sendToken", TOKEN, "bob.testnet", 5n * E18]);
  await runCommand("send", ctx(["0.5", "NEAR", "bob.testnet"]));
  assert.deepEqual(calls[1], ["transfer", "bob.testnet", 5n * 10n ** 23n]);
});

test("every command has the fields the platforms need", () => {
  for (const [name, c] of Object.entries(COMMANDS)) {
    assert.ok(c.section && c.description && Array.isArray(c.options) && typeof c.run === "function", name);
  }
});

test("a Sowellian proposal posts its bond", async () => {
  linked("sowellian");
  const r = await runCommand("signal", ctx(["Will", "the", "grant", "pay", "off?"]));
  assert.equal(calls[0][0], "proposeWithCriteria");
  assert.deepEqual(calls[1], ["sendToOrbit", 100n * E18, { proposal_bond: 0 }]);
  assert.match(r.text, /with a 100 ARK bond/);
});

test("positions go to the orbit as a token transfer", async () => {
  linked("sowellian");
  await runCommand("signal", ctx(["Q?"]));
  const r = await runCommand("position", ctx(["0", "yes", "25"]));
  assert.deepEqual(calls.at(-1), ["sendToOrbit", 25n * E18, { position: 0, side: "Yes" }]);
  assert.match(r.text, /bet 25 ARK on \*yes\*/);
});

test("decision markets: propose, seed, trade", async () => {
  linked("decisionMarkets");
  const proposed = await runCommand("pay", ctx(["1", "NEAR", "me", "grant"]));
  assert.match(proposed.text, /\/seed 0 <tokens> <NEAR>/);
  assert.match((await runCommand("seed", ctx(["0", "1000", "10"]))).text, /takes 1000 ARK; you have 100 ARK/);
  assert.equal(calls.length, 1, "nothing seeded on a short balance");
  await runCommand("seed", ctx(["0", "50", "10"]));
  assert.deepEqual(calls[1], ["seedNear", 0, 10n * 10n ** 24n]);
  assert.deepEqual(calls[2], ["sendToOrbit", 50n * E18, { seed: 0 }]);
  const traded = await runCommand("trade", ctx(["0", "pass", "0.5", "NEAR"]));
  assert.deepEqual(calls[3], ["trade", 0, "Pass", "Near", 5n * 10n ** 23n]);
  assert.match(traded.text, /for 7 ARK/);
  assert.match((await runCommand("trade", ctx(["0", "fail", "5", "NEAR"]))).text, /don't hold that many fail units/);
});
