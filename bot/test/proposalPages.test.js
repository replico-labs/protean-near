import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.PROPOSAL_SITE_URL = "https://protean.today/";
process.env.PROPOSAL_LINK_SECRET = "test-secret-that-is-long-enough";

const { services } = await import("../src/platforms/services.js");
const { runCommand } = await import("../src/platforms/commands.js");
const pages = await import("../src/proposalPages.js");
const { proposalButtons } = await import("../src/buttons.js");

const DAO = "ark.sputnik.protean.testnet";
const ORBIT = "tw.ark.protean.testnet";
const OLD_ORBIT = "qv.ark.protean.testnet";
const ME = "tg42.protean.testnet";
const E18 = 10n ** 18n;
const cmd = (n) => `/${n}`;
const ctx = { platform: "telegram", chatId: "-100", userId: "42", cmd };

let links, proposals, store;

const orbitProposal = (id, extra = {}) => ({
  id, proposer: ME, description: `payout ${id}`, kind: "Vote", state: "Active", start: "0", end: String(2_000_000_000n * 1_000_000_000n),
  for_votes: "0", against_votes: "0", abstain_votes: "0", voters: 0, support: "0", conviction: "0", required_conviction: "0", challenger: null, core_proposal_id: null, executable_after: null, ...extra,
});

beforeEach(() => {
  links = { "telegram:-100": { daoId: DAO, orbitId: ORBIT, model: "tokenWeighted", tokenId: "token.ark", stakingId: "staking.ark" } };
  proposals = { [ORBIT]: [orbitProposal(0)], [OLD_ORBIT]: [orbitProposal(0, { description: "old", state: "Executed" })] };
  store = pages.usePageStore();
  Object.assign(services, {
    isWalletStoreConfigured: () => true,
    db: {
      getChatDao: (p, c) => links[`${p}:${c}`] ?? null,
      setChatDao: (p, c, l) => (links[`${p}:${c}`] = l),
      chatsOn: (p) => Object.entries(links).filter(([k]) => k.startsWith(`${p}:`)).map(([k, l]) => [k.split(":")[1], l]),
    },
    orbit: {
      ...services.orbit,
      getProposal: async (o, id) => proposals[o]?.[id] ?? null,
      getDao: async (o) => (proposals[o] ? DAO : Promise.reject(new Error("no such contract"))),
      getModel: async () => ({ Quadratic: {} }),
      proposalDeposit: () => 0n,
      propose: async (account, o, description, kind) => {
        proposals[o].push(orbitProposal(proposals[o].length, { description, kind }));
        return proposals[o].length - 1;
      },
    },
    staking: { ...services.staking, tokenMetadata: async () => ({ symbol: "ARK", decimals: 18 }) },
    tokens: { ...services.tokens, load: async () => {}, format: (t, a) => `${a} ${t}` },
    wallets: { ...services.wallets, findUserAccountId: async (p, u) => (u === "42" ? ME : `tg${u}.protean.testnet`), getOrCreateUserAccount: async () => ({ accountId: ME }), ensureGas: async () => {} },
  });
});

const tokenFrom = (text) => decodeURIComponent(/\?edit=([^)\s]+)/.exec(text)[1]);

test("pages: a new proposal gets a Details button and a private edit link for its proposer", async () => {
  const r = await runCommand("signal", { ...ctx, args: ["Fund", "the", "docs"] });
  assert.match(r.text, /📝 New proposal/);
  assert.match(r.text, /I've sent them a private link/);
  const details = r.buttons.flat().find((b) => b.url);
  assert.equal(details.url, `https://protean.today/p/near-testnet/${ORBIT}/1`);
  assert.match(r.private.text, /\[open your edit page\]\(https:\/\/protean\.today\/p\/near-testnet\/tw\.ark\.protean\.testnet\/1\?edit=/);
  assert.equal(r.private.start, "pe_-100_1");
  assert.ok(pages.verifyEditToken(tokenFrom(r.private.text), { account: ORBIT, id: "1" }));
  assert.equal(pages.verifyEditToken(tokenFrom(r.private.text), { account: ORBIT, id: "2" }), null, "a link is for one proposal");

  // The page exists before any details are added.
  const page = await pages.getProposalPage("near-testnet", ORBIT, "1");
  assert.equal(page.status, 200);
  assert.equal(page.body.submittable, true);
  assert.equal(page.body.details, null);
  assert.equal(page.body.live.chain, "NEAR testnet");
  assert.equal(page.body.live.description, "Fund the docs");
  assert.deepEqual(page.body.live.actions, [{ label: "Signal vote (nothing is executed)" }]);
  assert.equal(page.body.live.proposer, ME);
});

test("pages: the first upload sets a password; edits need it, keep every version, and lock after 5 misses", async () => {
  await pages.proposalCreated(ctx, links["telegram:-100"], 0);
  const token = pages.editToken({ account: ORBIT, id: "0", platform: "telegram", userId: "42" });
  const form = { token, title: "Docs grant", summary: "Pay for docs", body: "Plan\n\nCosts", links: [{ label: "Spec", url: "https://example.com/spec" }] };

  assert.equal((await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...form, token: "bad.token" })).status, 403);
  assert.equal((await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...form, password: "short" })).status, 400);
  assert.equal((await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...form, links: [{ url: "javascript:alert(1)" }], password: "longenough" })).status, 400);
  const first = await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...form, password: "longenough" });
  assert.deepEqual([first.status, first.body.version], [200, 1]);

  const edit = { ...form, summary: "Pay for better docs" };
  const wrong = await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...edit, password: "wrongpassword" });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error, /4 tries left/);
  const second = await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...edit, password: "longenough" });
  assert.deepEqual([second.status, second.body.version], [200, 2]);
  assert.equal((await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...edit, password: "longenough" })).body.error, "Nothing changed.");

  const page = await pages.getProposalPage("near-testnet", ORBIT, "0");
  assert.equal(page.body.details.summary, "Pay for better docs");
  assert.deepEqual(page.body.history.map((v) => [v.version, v.summary]), [[1, "Pay for docs"], [2, "Pay for better docs"]]);
  assert.equal(page.body.editable, true);

  for (let i = 0; i < 4; i++) await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...edit, summary: "x", password: "wrongpassword" });
  const locked = await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...edit, summary: "x", password: "wrongpassword" });
  assert.match(locked.body.error, /locked for 15 minutes/, "the fifth miss locks it");
  assert.equal((await pages.saveProposalPage("near-testnet", ORBIT, "0", { ...edit, summary: "x", password: "longenough" })).status, 429, "even the right password waits");
});

test("pages: after the grace period, details close once anyone has voted", async () => {
  const k = { network: "near-testnet", orbit_id: ORBIT, proposal_id: "0" };
  await pages.proposalCreated(ctx, links["telegram:-100"], 0);
  store.age(k, 7);
  assert.equal((await pages.getProposalPage("near-testnet", ORBIT, "0")).body.submittable, true, "nobody voted yet");
  Object.assign(proposals[ORBIT][0], { voters: 1, for_votes: String(5n * E18) });
  const page = await pages.getProposalPage("near-testnet", ORBIT, "0");
  assert.equal(page.body.submittable, false);
  assert.deepEqual(page.body.live.facts.slice(0, 4).map((f) => f.value), ["5 ARK", "0 ARK", "0 ARK", "1"]);
  const token = pages.editToken({ account: ORBIT, id: "0", platform: "telegram", userId: "42" });
  assert.equal((await pages.saveProposalPage("near-testnet", ORBIT, "0", { token, title: "Late", password: "longenough" })).status, 409);
  // And /proposal stops re-sending the link.
  assert.equal((await runCommand("proposal", { ...ctx, args: ["0"] })).private, null);
});

test("pages: /proposal re-sends the link to its proposer only; /start in a DM sends it too", async () => {
  await pages.proposalCreated(ctx, links["telegram:-100"], 0);
  assert.match((await runCommand("proposal", { ...ctx, args: ["0"] })).private.text, /open your edit page/);
  assert.equal((await runCommand("proposal", { ...ctx, userId: "7", args: ["0"] })).private, null, "someone else");
  assert.match(await pages.editLinkFromStart("pe_-100_0", { ...ctx, chatId: "42" }), /open your edit page/);
  assert.match(await pages.editLinkFromStart("pe_-100_0", { ...ctx, userId: "7", chatId: "7" }), /only its proposer/);
  assert.equal(await pages.editLinkFromStart("other", ctx), null);
});

test("pages: only linked DAOs are served; an orbit swapped away from keeps its pages; boards use the core", async () => {
  assert.equal((await pages.getProposalPage("near-mainnet", ORBIT, "0")).status, 400);
  assert.equal((await pages.getProposalPage("near-testnet", "Not An Account", "0")).status, 400);
  assert.equal((await pages.getProposalPage("near-testnet", "someone.testnet", "0")).status, 404);
  assert.equal((await pages.getProposalPage("near-testnet", ORBIT, "9")).status, 404);

  const old = await pages.getProposalPage("near-testnet", OLD_ORBIT, "0");
  assert.equal(old.status, 200);
  assert.equal(old.body.live.model, "quadratic");
  assert.equal(old.body.live.state, "Executed");

  links["telegram:-100"] = { daoId: DAO, orbitId: null, model: "board", tokenId: "token.ark" };
  services.core = { ...services.core, getCoreProposal: async (d, id) => (d === DAO && id === "0" ? { proposer: ME, description: "board pay", kind: "Vote", status: "InProgress", vote_counts: { governance: ["1", "0", "0"] }, votes: { [ME]: "Approve" }, submission_time: "1700000000000000000" } : null) };
  const board = await pages.getProposalPage("near-testnet", DAO, "0");
  assert.equal(board.status, 200);
  assert.deepEqual(board.body.live.facts.map((f) => [f.label, f.value]), [["Approve", "1"], ["Reject", "0"]]);
  assert.equal(board.body.live.started, true);
  assert.deepEqual(board.body.live.times, [{ label: "Submitted", at: 1700000000 }]);
  assert.equal(pages.proposalPageUrl(links["telegram:-100"], 0), `https://protean.today/p/near-testnet/${DAO}/0`);
});

test("pages: the HTTP API answers the website, with CORS for it only", async () => {
  const server = await pages.startProposalApi(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/proposals/near-testnet/${ORBIT}/0`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://protean.today");
    assert.equal((await res.json()).live.id, "0");
    const pre = await fetch(`${base}/api/proposals/near-testnet/${ORBIT}/0`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    const bad = await fetch(`${base}/api/proposals/near-testnet/${ORBIT}/0`, { method: "POST", body: "not json" });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  } finally {
    server.close();
  }
});

test("pages: without the settings, no Details button and no private link", () => {
  assert.deepEqual(proposalButtons("tokenWeighted", 3, "Active", null).at(-1), [{ label: "🔄 Status", cmd: "proposal 3" }]);
  assert.deepEqual(proposalButtons("tokenWeighted", 3, "Active", "https://x/p/1").at(-1)[1], { label: "📄 Details", url: "https://x/p/1" });
});
