import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand, COMMANDS } from "../src/platforms/commands.js";
import { services } from "../src/platforms/services.js";
import { ChainError } from "../src/near/client.js";
import * as realEvm from "../src/near/evm.js";
import * as realHyperliquid from "../src/near/hyperliquid.js";

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
    wallets: { getOrCreateUserAccount: async () => account, ensureGas: async () => {}, availableBalance: async () => 5n * 10n ** 24n, gasHoldNear: async () => 3n * 10n ** 23n },
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
      getPolicy: async () => ({ proposal_period: "604800000000000" }),
      availableNear: async () => 10n * 10n ** 24n,
      getCoreProposal: async (dao, id) => state.coreProposals[id] ?? null,
      getCoreProposals: async (dao, from, limit) => state.coreProposals.slice(from, from + limit),
      getLastProposalId: async () => state.coreProposals.length,
      transactionOutcome: async (hash, sender) => {
        calls.push(["transactionOutcome", hash, sender]);
        return { receipts_outcome: [] };
      },
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
    venues: { wrapNear: "wrap.testnet" },
    hyperliquid: {
      ...realHyperliquid,
      account: async () => ({ accountValue: "120", withdrawable: "50", positions: [{ coin: "ETH", size: "0.1", value: "350" }] }),
      submit: async (action, sig) => {
        if (sig.r !== "0x0a") throw new Error("not the DAO's");
        calls.push(["hlSubmit", action]);
        return { status: "ok" };
      },
    },
    chainsig: {
      evmAddress: async () => "0x00000000000000000000000000000000000000AA",
      signKind: (hashes) => ({ FunctionCall: { receiver_id: "signer.testnet", actions: hashes.map((h) => ({ method_name: "sign", args: h, deposit: "1", gas: "50" })) } }),
      signaturesFrom: () => state.signatures ?? [],
    },
    evm: {
      ...realEvm,
      base: () => ({ name: "Base Sepolia", chainId: 84532, usdc: "0x00000000000000000000000000000000000000c1", aUsdc: "0x00000000000000000000000000000000000000c2", aavePool: "0x00000000000000000000000000000000000000c3", wethGateway: "0x00000000000000000000000000000000000000c4", aWeth: "0x00000000000000000000000000000000000000c5" }),
      balances: async () => state.evmBalances ?? { eth: 10n ** 16n, usdc: 20_000_000n, aUsdc: 3_000_000n },
      txParams: async () => ({ nonce: 3, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
      signedTx: async (serialized, sig) => {
        // Stands in for recovery: signature i belongs to the transaction with nonce 3 + i.
        if (realEvm.parseTx(serialized).nonce !== 3 + Number(BigInt(sig.r)) - 1) throw new Error("not the DAO's");
        return `${serialized}:signed:${sig.r}`;
      },
      broadcast: async (chain, signed) => {
        calls.push(["broadcast", signed]);
        return "0xhash" + calls.filter((c) => c[0] === "broadcast").length;
      },
    },
    intents: {
      intentsId: () => "intents.near",
      nearAsset: async (id) => ({ NEAR: { assetId: "nep141:wrap.testnet", symbol: "wNEAR", blockchain: "near", decimals: 24 }, "usdc.testnet": { assetId: "nep141:usdc.testnet", symbol: "USDC", blockchain: "near", decimals: 6 } })[id] ?? null,
      findAsset: async (text) => {
        const assets = { btc: { assetId: "nep141:btc.omft.near", symbol: "BTC", blockchain: "btc", decimals: 8 }, "usdc@sol": { assetId: "nep141:sol-usdc.omft.near", symbol: "USDC", blockchain: "sol", decimals: 6 } };
        if (text.toLowerCase() === "usdc") throw new Error("USDC is on near, sol; pick one, e.g. USDC@near");
        return assets[text.toLowerCase()] ?? null;
      },
      quote: async (request) => {
        calls.push(["quote", request]);
        const exact = request.exactOutput;
        return {
          depositAddress: "a".repeat(64),
          correlationId: "corr-1",
          amountIn: exact ? "1020000" : String(request.amount),
          amountOut: exact ? String(request.amount) : "150000",
          minAmountOut: exact ? String(request.amount) : "148500",
          deadline: (state.quoteDeadline ?? new Date(request.deadline.getTime())).toISOString(),
        };
      },
      prepareDao: async (dao, token, to) => calls.push(["intentsPrepare", token, to?.assetId ?? null]),
      status: async () => ({ status: "SUCCESS" }),
      balanceOf: async () => state.intentsBalance ?? 0n,
      holdings: async () => [],
    },
    tokens: {
      resolve: (text, daoToken) => ({ NEAR: "NEAR", USDC: "usdc.testnet", [daoToken.symbol]: daoToken.id })[text.toUpperCase()] ?? null,
      info: async (id) => (id === "usdc.testnet" ? { symbol: "USDC", decimals: 6 } : { symbol: "ARK", decimals: 18 }),
      load: async () => {},
      format: (id, amount) => `${amount} ${id === "NEAR" ? "yoctoNEAR" : id}`,
    },
    rhea: {
      exchangeId: () => "ref.testnet",
      quote: async (from, to, amount) => {
        calls.push(["quote", from, to, amount]);
        if (to === TOKEN) return null;
        return { hops: [{ pool_id: 7, token_in: "wrap.testnet", token_out: "usdc.testnet", out: 5_000_000n }], out: 5_000_000n };
      },
      withSlippage: (amount, bps) => (amount * BigInt(10_000 - bps)) / 10_000n,
      routeActions: (hops, amountIn, minOut) => hops.map((h) => ({ pool_id: h.pool_id, token_in: h.token_in, token_out: h.token_out, amount_in: String(amountIn), min_amount_out: String(minOut) })),
      prepareDao: async (dao, from, to) => calls.push(["prepareDao", dao, from, to]),
    },
    lst: {
      provider: (key = "linear") => {
        const ids = { linear: "linear.testnet", metapool: "metapool.testnet", nearx: "nearx.testnet" };
        if (!ids[key]) throw new Error(`Liquid staking "${key}" isn't configured on this network`);
        return { key, id: ids[key], label: { linear: "LiNEAR", metapool: "Meta Pool", nearx: "Stader (NearX)" }[key], withdrawMethod: key === "metapool" ? "withdraw_unstaked" : "withdraw_all" };
      },
      providers: () => [["linear", "linear.testnet"], ["metapool", "metapool.testnet"], ["nearx", "nearx.testnet"]],
      position: async () => state.lstPosition ?? { staked: 3n * 10n ** 24n, unstaked: 0n, available: false },
    },
    orbit: {
      proposalDeposit: () => 10n ** 22n,
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
      executeWithOutcome: async (acct, orbit, id, options) => {
        calls.push(["executeWithOutcome", id]);
        await options?.onSent?.("NearTx1");
        state.proposals[id].state = "Executed";
        return { receipts_outcome: [] };
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

test("tip sends the DAO's token to the member replied to, and links the transaction", async () => {
  linked();
  services.wallets.getOrCreateUserAccount = async (platform, userId) => ({ accountId: userId === "42" ? ME : `tg${userId}.orbits.testnet` });
  services.staking.sendToken = async (acct, token, to, amount) => {
    calls.push(["sendToken", token, to, amount]);
    return "TxHash1";
  };
  const res = await runCommand("tip", ctx(["25"], { replyTo: { userId: "7", name: "Bola" } }));
  assert.deepEqual(calls[0], ["sendToken", TOKEN, "tg7.orbits.testnet", 25n * E18]);
  assert.match(res.text, /Sent 25 ARK to Bola \(`tg7\.orbits\.testnet` · \[Explorer\]\(https:\/\/testnet\.nearblocks\.io\/address\/tg7\.orbits\.testnet\)\)/);
  assert.match(res.text, /\[View transaction\]\(https:\/\/testnet\.nearblocks\.io\/txns\/TxHash1\)/);
  // /send works the same way as a reply, and with a Discord mention
  await runCommand("send", ctx(["2", "ARK"], { replyTo: { userId: "7", name: "Bola" } }));
  links["discord:-100"] = links["telegram:-100"];
  await runCommand("send", ctx(["3", "ARK", "<@9>"], { platform: "discord" }));
  assert.deepEqual(calls.slice(1), [["sendToken", TOKEN, "tg7.orbits.testnet", 2n * E18], ["sendToken", TOKEN, "tg9.orbits.testnet", 3n * E18]]);
});

test("tip explains what it needs, and refuses more than you hold or a username", async () => {
  linked();
  assert.match((await runCommand("tip", ctx(["25"]))).text, /Reply to someone's message with `\/tip <amount>`/);
  assert.match((await runCommand("tip", ctx(["25", "@bola"]))).text, /can't find an account from a username\. Reply to one of @bola's messages with `\/tip <amount>`/);
  assert.match((await runCommand("tip", ctx(["500", "bob.testnet"]))).text, /You have 100 ARK in your account/);
  assert.equal(calls.length, 0);
});

test("a reply in a forum topic isn't a reply to anyone", async () => {
  const { repliedTo } = await import("../src/platforms/telegram.js");
  const from = { id: 7, first_name: "Bola" };
  assert.deepEqual(repliedTo({ reply_to_message: { message_id: 5, from } }), { userId: "7", name: "Bola" });
  assert.equal(repliedTo({ is_topic_message: true, message_thread_id: 5, reply_to_message: { message_id: 5, from } }), null);
  assert.equal(repliedTo({ reply_to_message: { message_id: 5, from: { id: 1, is_bot: true } } }), null);
  assert.equal(repliedTo({}), null);
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
  assert.match((await runCommand("seed", ctx(["0", "1000", "1"]))).text, /takes 1000 ARK; you have 100 ARK/);
  assert.match((await runCommand("seed", ctx(["0", "50", "10"]))).text, /takes 10 NEAR; your account has 4\.7 spendable \(it keeps 0\.3 for gas\)/);
  assert.equal(calls.length, 1, "nothing seeded on a short balance");
  await runCommand("seed", ctx(["0", "50", "1"]));
  assert.deepEqual(calls[1], ["seedNear", 0, 10n ** 24n]);
  assert.deepEqual(calls[2], ["sendToOrbit", 50n * E18, { seed: 0 }]);
  const traded = await runCommand("trade", ctx(["0", "pass", "0.5", "NEAR"]));
  assert.deepEqual(calls[3], ["trade", 0, "Pass", "Near", 5n * 10n ** 23n]);
  assert.match(traded.text, /for 7 ARK/);
  assert.match((await runCommand("trade", ctx(["0", "fail", "5", "NEAR"]))).text, /don't hold that many fail units/);
});

const decodeCall = (kind) => kind.FunctionCall.actions.map((a) => ({ ...a, args: JSON.parse(Buffer.from(a.args, "base64").toString()) }));

test("swap proposes a Rhea swap with the minimum after slippage, registering the DAO first", async () => {
  linked();
  const r = await runCommand("swap", ctx(["1", "NEAR", "USDC"]));
  assert.match(r.text, /New proposal/);
  assert.deepEqual(calls.find((c) => c[0] === "prepareDao"), ["prepareDao", DAO, "NEAR", "usdc.testnet"]);
  const [, , description, kind] = calls.find((c) => c[0] === "propose");
  assert.match(description, /at least 4950000 usdc.testnet \(1% slippage\)/);
  // NEAR is wrapped first, in the same proposal, then sent to Rhea with the route.
  assert.equal(kind.FunctionCall.receiver_id, "wrap.testnet");
  const [wrap, transfer] = decodeCall(kind);
  assert.equal(wrap.method_name, "near_deposit");
  assert.equal(wrap.deposit, String(10n ** 24n));
  assert.equal(transfer.args.receiver_id, "ref.testnet");
  assert.equal(JSON.parse(transfer.args.msg).actions[0].min_amount_out, "4950000");

  // A token from the treasury goes straight to Rhea; slippage can be set.
  calls = [];
  await runCommand("swap", ctx(["10", "ARK", "USDC", "0.5%"]));
  const tokenKind = calls.find((c) => c[0] === "propose")[3];
  assert.equal(tokenKind.FunctionCall.receiver_id, TOKEN);
  assert.equal(JSON.parse(decodeCall(tokenKind)[0].args.msg).actions[0].min_amount_out, "4975000");
});

test("swap refuses what the treasury can't cover, unknown tokens and pairs without liquidity", async () => {
  linked();
  assert.match((await runCommand("swap", ctx(["11", "NEAR", "USDC"]))).text, /treasury has/);
  assert.match((await runCommand("swap", ctx(["1", "NEAR", "DOGE"]))).text, /isn't a token I know/);
  assert.match((await runCommand("swap", ctx(["1", "NEAR", "ARK"]))).text, /no liquidity/);
  assert.match((await runCommand("swap", ctx(["1", "NEAR", "USDC", "90"]))).text, /Slippage/);
  assert.ok(!calls.some((c) => c[0] === "propose" || c[0] === "prepareDao"));
});

test("liquid staking: stake, unstake and withdraw by proposal", async () => {
  linked();
  await runCommand("liquidstake", ctx(["2"]));
  let kind = calls.find((c) => c[0] === "propose")[3];
  assert.equal(kind.FunctionCall.receiver_id, "linear.testnet");
  assert.deepEqual([kind.FunctionCall.actions[0].method_name, kind.FunctionCall.actions[0].deposit], ["deposit_and_stake", String(2n * 10n ** 24n)]);
  assert.match((await runCommand("liquidstake", ctx(["11"]))).text, /available, less than/);
  assert.match((await runCommand("liquidstake", ctx(["1", "lido"]))).text, /Choose linear or metapool or nearx/);
  calls = [];
  await runCommand("liquidstake", ctx(["1", "nearx"]));
  assert.equal(calls.find((c) => c[0] === "propose")[3].FunctionCall.receiver_id, "nearx.testnet");

  calls = [];
  await runCommand("liquidunstake", ctx(["1", "metapool"]));
  kind = calls.find((c) => c[0] === "propose")[3];
  assert.deepEqual([kind.FunctionCall.receiver_id, decodeCall(kind)[0].method_name, decodeCall(kind)[0].args.amount], ["metapool.testnet", "unstake", String(10n ** 24n)]);
  assert.match((await runCommand("liquidunstake", ctx(["4"]))).text, /has 3 NEAR staked/);

  assert.match((await runCommand("liquidwithdraw", ctx([]))).text, /Nothing is unstaking/);
  state.lstPosition = { staked: 0n, unstaked: 10n ** 24n, available: false };
  assert.match((await runCommand("liquidwithdraw", ctx([]))).text, /still unstaking/);
  state.lstPosition.available = true;
  calls = [];
  await runCommand("liquidwithdraw", ctx(["metapool"]));
  assert.equal(decodeCall(calls.find((c) => c[0] === "propose")[3])[0].method_name, "withdraw_unstaked");
});

test("buy funds a NEAR Intents quote that outlives the proposal; bought assets stay in the DAO's Intents account", async () => {
  linked();
  const r = await runCommand("buy", ctx(["1", "NEAR", "BTC"]));
  assert.match(r.text, /New proposal/);
  const [, request] = calls.find((c) => c[0] === "quote");
  assert.deepEqual([request.from.assetId, request.to.assetId, request.amount, request.recipient, request.recipientType, request.exactOutput ?? false], ["nep141:wrap.testnet", "nep141:btc.omft.near", 10n ** 24n, DAO, "INTENTS", false]);
  // Token-weighted settings here: voting 1h + timelock 1min + window "1" ns; the deadline asks for an hour more than that.
  const horizon = 3_600_000_000_000n + 60_000_000_000n + 1n;
  assert.ok(BigInt(request.deadline.getTime()) * 1_000_000n >= BigInt(Date.now()) * 1_000_000n + horizon);
  const [, , description, kind] = calls.find((c) => c[0] === "propose");
  assert.match(description, /^Buy at least 0\.001485 BTC on btc \(quoted 0\.0015 BTC on btc\) with 1 NEAR, held in the DAO's NEAR Intents account via NEAR Intents\. Quote corr-1/);
  assert.equal(kind.FunctionCall.receiver_id, "wrap.testnet");
  const [wrap, deposit] = decodeCall(kind);
  assert.equal(wrap.method_name, "near_deposit");
  assert.deepEqual([deposit.args.receiver_id, deposit.args.msg, deposit.args.amount], ["intents.near", "a".repeat(64), String(10n ** 24n)]);
  assert.deepEqual(calls.find((c) => c[0] === "intentsPrepare"), ["intentsPrepare", "NEAR", "nep141:btc.omft.near"]);
});

test("buy refuses a quote that would expire before the proposal can execute, and models without a fixed end", async () => {
  linked();
  assert.match((await runCommand("buy", ctx(["1", "NEAR", "USDC"]))).text, /pick one, e\.g\. USDC@near/);
  assert.match((await runCommand("buy", ctx(["20", "NEAR", "BTC"]))).text, /the treasury has/);
  state.quoteDeadline = new Date(Date.now() + 60_000);
  assert.match((await runCommand("buy", ctx(["1", "NEAR", "BTC"]))).text, /before this proposal could still execute/);
  linked("conviction");
  assert.match((await runCommand("buy", ctx(["1", "NEAR", "BTC"]))).text, /no fixed end/);
  assert.ok(!calls.some((c) => c[0] === "propose"));
});

test("paychain pays an exact amount on another chain, from the same token if the treasury holds it", async () => {
  linked();
  await runCommand("paychain", ctx(["1", "USDC@sol", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "March", "design", "work"]));
  const [, request] = calls.find((c) => c[0] === "quote");
  assert.deepEqual([request.from.assetId, request.amount, request.exactOutput, request.recipient, request.recipientType], ["nep141:usdc.testnet", 1_000_000n, true, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "DESTINATION_CHAIN"]);
  const [, , description, kind] = calls.find((c) => c[0] === "propose");
  assert.match(description, /^March design work: pay 1 USDC on sol to 9xQe.*using up to 1\.02 USDC/);
  // USDC goes straight into Intents: no wrapping.
  assert.equal(kind.FunctionCall.receiver_id, "usdc.testnet");
  assert.equal(decodeCall(kind)[0].args.amount, "1020000");
});

test("intentswithdraw brings refunds back to the treasury", async () => {
  linked();
  assert.match((await runCommand("intentswithdraw", ctx(["1", "USDC"]))).text, /account has 0 USDC/);
  state.intentsBalance = 5_000_000n;
  await runCommand("intentswithdraw", ctx(["1", "USDC"]));
  const kind = calls.find((c) => c[0] === "propose")[3];
  assert.equal(kind.FunctionCall.receiver_id, "intents.near");
  assert.deepEqual(decodeCall(kind)[0].args, { token: "usdc.testnet", receiver_id: DAO, amount: "1000000" });
});

test("aave supply proposes signing approve + supply from the DAO's EVM address; executing sends them", async () => {
  linked();
  const r = await runCommand("aave", ctx(["supply", "5"]));
  assert.match(r.text, /New proposal/);
  const [, , description, kind] = calls.find((c) => c[0] === "propose");
  assert.equal(kind.FunctionCall.receiver_id, "signer.testnet");
  assert.equal(kind.FunctionCall.actions.length, 2, "approve, then supply");
  const payload = realEvm.txsIn(description);
  assert.deepEqual([payload.chain, payload.from, payload.txs.length], [84532, "0x00000000000000000000000000000000000000AA", 2]);
  assert.match(realEvm.readable(description), /^Supply 5 USDC to Aave \(on Base Sepolia, from the DAO's address 0x0+AA\)$/);
  // What the chat shows leaves the raw transactions out.
  assert.ok(!r.text.includes("evm:"));

  state.proposals[0].state = "Succeeded";
  // They arrive in the other order; each still goes with its own transaction.
  state.signatures = [{ r: "0x02", s: "0x04", yParity: 1 }, { r: "0x01", s: "0x02", yParity: 0 }];
  const executed = await runCommand("execute", ctx(["0"]));
  assert.ok(calls.some((c) => c[0] === "executeWithOutcome"));
  assert.deepEqual(calls.filter((c) => c[0] === "broadcast").map((c) => c[1].split(":signed:")[1]), ["0x01", "0x02"]);
  assert.match(executed.text, /Sent on Base Sepolia: `0xhash1`[\s\S]*Sent on Base Sepolia: `0xhash2`/);
});

test("if sending what an execution signed fails, /execute again reads the execution and finishes it", async () => {
  linked();
  await runCommand("aave", ctx(["supply", "5"]));
  state.proposals[0].state = "Succeeded";
  state.signatures = [{ r: "0x01", s: "0x02", yParity: 0 }, { r: "0x02", s: "0x04", yParity: 1 }];
  const realBroadcast = services.evm.broadcast;
  let down = true;
  services.evm.broadcast = async (chain, signed) => {
    if (down && signed.endsWith(":signed:0x02")) throw new Error("Base is down");
    if (!down && signed.endsWith(":signed:0x01")) throw new Error("already known");
    return realBroadcast(chain, signed);
  };
  const first = await runCommand("execute", ctx(["0"]));
  assert.match(first.text, /Sent on Base Sepolia: `0xhash1`[\s\S]*Transaction 2 wasn't sent: Base is down[\s\S]*`\/execute 0` tries sending again/);
  assert.deepEqual(links["telegram:-100"].relays, { 0: { txHash: "NearTx1", sender: ME } });

  down = false;
  const second = await runCommand("execute", ctx(["0"]));
  assert.deepEqual(calls.find((c) => c[0] === "transactionOutcome"), ["transactionOutcome", "NearTx1", ME]);
  assert.match(second.text, /executed earlier; sending what it signed[\s\S]*Transaction 1 was already sent[\s\S]*Sent on Base Sepolia: `0xhash/);
  assert.deepEqual(links["telegram:-100"].relays, {}, "nothing left to send");
  assert.match((await runCommand("execute", ctx(["0"]))).text, /already executed/);
});

test("aave refuses without gas or funds, a second open EVM proposal, and bad input", async () => {
  linked();
  state.evmBalances = { eth: 0n, usdc: 20_000_000n, aUsdc: 0n };
  assert.match((await runCommand("aave", ctx(["supply", "5"]))).text, /needs up to .* ETH for gas[\s\S]*paychain 0.002 ETH@base dao/);
  state.evmBalances = { eth: 10n ** 16n, usdc: 1_000_000n, aUsdc: 0n };
  assert.match((await runCommand("aave", ctx(["supply", "5"]))).text, /has 1 USDC/);
  assert.match((await runCommand("aave", ctx(["withdraw", "all"]))).text, /no USDC on Aave/);
  assert.match((await runCommand("aave", ctx(["borrow", "5"]))).text, /Usage/);
  state.evmBalances = undefined;
  await runCommand("aave", ctx(["withdraw", "all"]));
  assert.match((await runCommand("aave", ctx(["withdraw", "1"]))).text, /still open/);
});

test("aave supplies ETH through Aave's gateway, and withdraws it after approving the aWETH", async () => {
  linked();
  const { decodeFunctionData, parseAbi } = await import("viem");
  const gateway = parseAbi(["function depositETH(address,address,uint16) payable", "function withdrawETH(address,uint256,address)", "function approve(address,uint256)"]);
  const args = (data) => decodeFunctionData({ abi: gateway, data }).args.map((a) => (typeof a === "string" ? a.toLowerCase() : a));
  const proposedTxs = () => realEvm.txsIn(calls.filter((c) => c[0] === "propose").at(-1)[2]).txs.map(realEvm.parseTx);

  state.evmBalances = { eth: 10n ** 16n, usdc: 0n, aUsdc: 0n, aWeth: 0n };
  await runCommand("aave", ctx(["supply", "0.005", "eth"]));
  const [deposit] = proposedTxs();
  assert.equal(deposit.to, "0x00000000000000000000000000000000000000c4");
  assert.equal(deposit.value, 5n * 10n ** 15n, "the ETH goes with the call");
  assert.deepEqual(args(deposit.data), ["0x00000000000000000000000000000000000000c3", "0x00000000000000000000000000000000000000aa", 0]);
  assert.match(realEvm.readable(calls.at(-1)[2]), /^Supply 0\.005 ETH to Aave/);

  state.proposals = [];
  state.evmBalances = { eth: 10n ** 16n, usdc: 0n, aUsdc: 0n, aWeth: 3n * 10n ** 15n };
  await runCommand("aave", ctx(["withdraw", "all", "ETH"]));
  const [approve, withdraw] = proposedTxs();
  const max = 2n ** 256n - 1n;
  assert.equal(approve.to, "0x00000000000000000000000000000000000000c5");
  assert.deepEqual(args(approve.data), ["0x00000000000000000000000000000000000000c4", max]);
  assert.deepEqual(args(withdraw.data), ["0x00000000000000000000000000000000000000c3", max, "0x00000000000000000000000000000000000000aa"]);

  state.proposals = [];
  state.evmBalances = { eth: 10n ** 15n, usdc: 0n, aUsdc: 0n, aWeth: 0n };
  assert.match((await runCommand("aave", ctx(["supply", "0.001", "ETH"]))).text, /needs 0\.001 ETH plus up to .* for gas, and has 0\.001 ETH/);
  assert.match((await runCommand("aave", ctx(["supply", "1", "DOGE"]))).text, /USDC or ETH/);
});

test("trading from the chat: a vote names the traders and limits; only traders trade, and only within them", async () => {
  linked();
  const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
  const AGENT = (await import("viem/accounts")).privateKeyToAccount(KEY).address;
  services.wallets.getOrCreateUserAccount = async (p, userId) => ({ accountId: userId === "42" ? ME : `tg${userId}.orbits.testnet` });
  services.hlAgents = {
    getOrCreateAgentKey: async () => ((state.agentStored = true), { address: AGENT, privateKey: async () => KEY }),
    findAgentAddress: async () => (state.agentStored ? AGENT : null),
  };
  Object.assign(services.hyperliquid, {
    markets: async () => ({ ETH: { coin: "ETH", asset: 1, szDecimals: 4, maxLeverage: 25 }, BTC: { coin: "BTC", asset: 0, szDecimals: 5, maxLeverage: 40 }, DOGE: { coin: "DOGE", asset: 7, szDecimals: 0, maxLeverage: 10 } }),
    mids: async () => ({ ETH: 3300, BTC: 60000, DOGE: 0.1 }),
    agents: async () => (state.agentApproved ? [{ name: "protean", address: AGENT.toLowerCase() }] : []),
    sendL1: async (key, action) => {
      calls.push(["sendL1", key, action]);
      if (action.type !== "order") return { type: "default" };
      return { type: "order", data: { statuses: [{ filled: { totalSz: action.orders[0].s, avgPx: "3301.5", oid: 9 } }] } };
    },
  });
  // A proposal that passed: the orbit executed it and the core approved it, as on chain.
  const pass = () => {
    const p = state.proposals.at(-1);
    p.state = "Executed";
    state.coreProposals.push({ id: state.coreProposals.length, description: p.description, kind: p.kind, status: "Approved" });
  };
  const said = async (name, args, extra) => (await runCommand(name, ctx(args, extra))).text;

  assert.match(await said("long", ["ETH", "500", "3x"]), /Only the DAO's traders trade from the chat, and it has none yet/);
  await runCommand("hltraders", ctx(["add", "me"]));
  const added = state.proposals.at(-1);
  assert.equal(realEvm.readable(added.description), `Hyperliquid trading rules: add ${ME} as a trader`);
  assert.equal(added.kind, "Vote", "a signal: nothing to execute but the record");
  assert.match(await said("hllimits", ["size", "1000"]), /still open/, "one rules proposal at a time");
  pass();
  assert.match(await said("long", ["ETH", "500"]), /needs a position limit, a leverage limit, markets/);
  for (const limit of [["size", "$1,000"], ["leverage", "5x"], ["markets", "eth,", "btc"]]) {
    await runCommand("hllimits", ctx(limit));
    pass();
  }
  assert.match(await said("hllimits", ["markets", "FOO"]), /no perp market for FOO/);
  assert.match(await said("hyperliquid", []), /Traders: `tg42\.orbits\.testnet`\nLimits: positions up to \$1,000 per market · leverage up to 5× · markets ETH, BTC/);

  assert.match(await said("long", ["ETH", "500"]), /hasn't approved the bot as its Hyperliquid agent/);
  await runCommand("hlagent", ctx(["bot"]));
  assert.equal(realEvm.txsIn(state.proposals.at(-1).description).actions[0].agentAddress, AGENT);
  state.agentApproved = true;

  assert.match(await said("long", ["DOGE", "50"]), /trades only ETH, BTC/);
  assert.match(await said("long", ["ETH", "500", "6x"]), /Leverage is limited to 5×/);
  // The account already holds 0.1 ETH ($330): $800 more would make $1,130.
  assert.match(await said("long", ["ETH", "800"]), /make the DAO's ETH position \$1,130; the DAO allows \$1,000 per market \(room for about \$670 more\)/);
  assert.match(await said("short", ["ETH", "50"], { userId: "7" }), /Only the DAO's traders/);
  assert.equal(calls.filter((c) => c[0] === "sendL1").length, 0, "nothing sent so far");

  assert.match(await said("long", ["ETH", "500", "3x"]), /📈 Bought 0\.1515 ETH at \$3301\.5 \(≈ \$500\.18\), 3× leverage/);
  const [leverage, order] = calls.filter((c) => c[0] === "sendL1");
  assert.equal(leverage[1], KEY, "signed with the bot's agent key for the DAO");
  assert.deepEqual(leverage[2], { type: "updateLeverage", asset: 1, isCross: true, leverage: 3 });
  assert.deepEqual(order[2].orders[0], { a: 1, b: true, p: "3333", s: "0.1515", r: false, t: { limit: { tif: "Ioc" } } });

  assert.match(await said("close", ["ETH"]), /✅ Closed 0\.1 ETH/);
  assert.deepEqual(calls.filter((c) => c[0] === "sendL1").at(-1)[2].orders[0], { a: 1, b: false, p: "3267", s: "0.1", r: true, t: { limit: { tif: "Ioc" } } });
});

test("hlmove proposes moving the DAO's spot USDC to perps, where trading can use it", async () => {
  linked();
  services.hyperliquid.account = async () => ({ accountValue: "0.0", withdrawable: "0.0", positions: [], spotUsdc: "151.0" });
  assert.match((await runCommand("hyperliquid", ctx([]))).text, /Spot: 151\.0 USDC, not usable for trading until moved: `\/hlmove all perps`/);
  assert.match((await runCommand("hlmove", ctx(["500"]))).text, /has 151\.0 USDC in spot/);
  await runCommand("hlmove", ctx(["all", "perps"]));
  const [action] = realEvm.txsIn(state.proposals.at(-1).description).actions;
  assert.deepEqual([action.type, action.amount, action.toPerp, action.hyperliquidChain], ["usdClassTransfer", "151", true, "Testnet"]);
  assert.match(realEvm.readable(state.proposals.at(-1).description), /^Move 151 USDC in the DAO's Hyperliquid account from spot to perps, for trading/);
  assert.match(realHyperliquid.digest(action), /^0x[0-9a-f]{64}$/, "signs as HyperliquidTransaction:UsdClassTransfer");
  assert.match((await runCommand("hlmove", ctx(["1", "sideways"]))).text, /Usage/);
});

test("paychain can pay the DAO's own EVM address", async () => {
  linked();
  await runCommand("paychain", ctx(["1", "USDC@sol", "dao", "x"]));
  assert.ok(!calls.some((c) => c[0] === "quote"), "Solana isn't an EVM chain");
});

test("hlagent proposes an agent that can trade, not withdraw; executing posts it to Hyperliquid", async () => {
  linked();
  const agent = "0x1111111111111111111111111111111111111111";
  const r = await runCommand("hlagent", ctx([agent]));
  assert.match(r.text, /New proposal/);
  const [, , description, kind] = calls.find((c) => c[0] === "propose");
  const payload = realEvm.txsIn(description);
  assert.equal(payload.hyperliquid, true);
  const [action] = payload.actions;
  assert.deepEqual([action.type, action.agentAddress, action.agentName, action.signatureChainId], ["approveAgent", agent, "protean", "0x66eee"]);
  // The DAO's key is asked to sign exactly this action's digest.
  assert.equal(kind.FunctionCall.actions[0].args, realHyperliquid.digest(action));
  assert.match(realEvm.readable(description), /can place and cancel orders, but not withdraw .*Execute by/);

  state.proposals[0].state = "Succeeded";
  state.signatures = [{ r: "0x09", s: "0x01", yParity: 0 }, { r: "0x0a", s: "0x01", yParity: 0 }];
  const executed = await runCommand("execute", ctx(["0"]));
  assert.deepEqual(calls.find((c) => c[0] === "hlSubmit")[1], action);
  assert.match(executed.text, /Hyperliquid accepted the agent 0x1{40}/);
});

test("hlrevoke replaces the agent with an address nobody holds; hlsend checks what's withdrawable", async () => {
  linked();
  await runCommand("hlrevoke", ctx([]));
  const [action] = realEvm.txsIn(calls.find((c) => c[0] === "propose")[2]).actions;
  assert.equal(action.agentName, "protean");
  assert.match(action.agentAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.match((await runCommand("hlsend", ctx(["60", "0x2222222222222222222222222222222222222222"]))).text, /50 USDC withdrawable/);
  assert.match((await runCommand("hlagent", ctx(["bob.near"]))).text, /isn't an EVM address/);
  calls = [];
  await runCommand("hlsend", ctx(["12.50", "0x2222222222222222222222222222222222222222"]));
  assert.equal(realEvm.txsIn(calls.find((c) => c[0] === "propose")[2]).actions[0].amount, "12.5");
  assert.match((await runCommand("hyperliquid", ctx([]))).text, /Perps \(trading\): \$120 · Withdrawable: 50 USDC[\s\S]*ETH: 0\.1/);
});
