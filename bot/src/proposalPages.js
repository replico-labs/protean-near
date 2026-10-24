import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { EXPLORER_URL, NETWORK_ID } from "./config.js";
import { describeKind, kindTokens } from "./near/kinds.js";
import { readable } from "./near/evm.js";
import { services } from "./platforms/services.js";
import { formatNear, tokenInfo } from "./platforms/helpers.js";
import { supabaseMessage, supabaseUrl } from "./supabaseError.js";

/**
 * Proposal pages: every proposal gets a page on the Protean website
 * (PROPOSAL_SITE_URL/p/<network>/<account>/<id>) holding details its
 * proposer writes there, next to live on-chain data. The same pages, API
 * and rules as the EVM/Solana bot's, so the website renders both.
 *
 * <account> is the orbit the proposal lives in: proposals are numbered per
 * orbit, and a model switch makes a new orbit that starts again from 0, so
 * the old pages stay right. A board has no orbit: its core DAO.
 *
 * The bot is the backend. The website is static, so it fetches
 * GET /api/proposals/<network>/<account>/<id> from here for the details and
 * the live state, and POSTs the form back. Only the proposer can write:
 * right after proposing, the bot sends them privately an edit link carrying
 * a token signed with PROPOSAL_LINK_SECRET. With the first upload the
 * proposer sets an edit password; any later edit needs the link AND that
 * password, so a forwarded or leaked link alone can't change anything.
 * Every saved version is kept and shown on the page.
 *
 * Details can be uploaded or edited during a grace period after proposing
 * (PROPOSAL_DETAILS_GRACE_HOURS, default 6) even if people have already
 * voted; after that, only while nobody has voted, backed or challenged it,
 * up to EDIT_WINDOW_HOURS. Until then, /proposal re-sends the proposer
 * their link.
 *
 * Details live in Supabase (proposal_details and proposal_detail_versions,
 * see supabase/schema.sql).
 */

const EDIT_WINDOW_HOURS = 72;
const LIMITS = { title: 140, summary: 600, body: 20_000, links: 10, link: 500 };
const MAX_VERSIONS = 20;
const PASSWORD = { min: 8, max: 200, failuresBeforeLock: 5, lockMinutes: 15 };

/** The network word in page URLs: near-testnet, near-mainnet, near-sandbox. */
export const PAGE_NETWORK = `near-${NETWORK_ID}`;
const CHAIN_NAME = { testnet: "NEAR testnet", mainnet: "NEAR", sandbox: "NEAR sandbox" }[NETWORK_ID];

function graceHours() {
  const h = Number(process.env.PROPOSAL_DETAILS_GRACE_HOURS ?? 6);
  return Number.isFinite(h) && h >= 0 ? Math.min(h, EDIT_WINDOW_HOURS) : 6;
}

const windowText = () =>
  `Do it within ${graceHours()} hours, or later as long as nobody has voted on or backed it yet (up to ${EDIT_WINDOW_HOURS} hours).`;

export function proposalPagesConfigured() {
  return Boolean(siteUrl() && process.env.PROPOSAL_LINK_SECRET && (memoryStore || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)));
}

function siteUrl() {
  return (process.env.PROPOSAL_SITE_URL || "").replace(/\/+$/, "");
}

const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** The account a chat's proposals live in: its orbit, or a board's core. */
export const pageAccount = (link) => (link?.model === "board" ? link.daoId : link?.orbitId) ?? null;

/** The public page for proposal `id` of a chat's DAO, or null when pages aren't set up. */
export function proposalPageUrl(link, id) {
  const account = pageAccount(link);
  if (!proposalPagesConfigured() || !account) return null;
  return `${siteUrl()}/p/${PAGE_NETWORK}/${account}/${id}`;
}

/*//////////////////////////////////////////////////////////////
                            EDIT TOKENS
//////////////////////////////////////////////////////////////*/

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload) => b64url(crypto.createHmac("sha256", process.env.PROPOSAL_LINK_SECRET).update(payload).digest());

/** A token letting its holder edit one proposal's details until it expires. */
export function editToken({ account, id, platform, userId }) {
  const payload = b64url(JSON.stringify({ n: PAGE_NETWORK, d: account, i: String(id), p: platform, u: String(userId), e: Date.now() + EDIT_WINDOW_HOURS * 3_600_000 }));
  return `${payload}.${sign(payload)}`;
}

/** The token's claims, if this bot signed it for this proposal and it hasn't expired. */
export function verifyEditToken(token, { account, id }) {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.n !== PAGE_NETWORK || claims.d !== account || claims.i !== String(id)) return null;
  return claims.e > Date.now() ? claims : null;
}

function editUrl(link, id, platform, userId) {
  return `${proposalPageUrl(link, id)}?edit=${editToken({ account: pageAccount(link), id, platform, userId })}`;
}

/*//////////////////////////////////////////////////////////////
                            STORAGE
//////////////////////////////////////////////////////////////*/

/**
 * Where details live. `k` is { network, orbit_id, proposal_id } (orbit_id:
 * the page's account, a board's core included); rows use the column names
 * of supabase/schema.sql. The two conditional writes keep
 * racing saves apart: a first upload only lands while there's no title,
 * an edit only over the version it was based on.
 */
function supabaseStore() {
  const client = createClient(supabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const fail = (what, error) => {
    throw new Error(`${what}: ${supabaseMessage(error)}`);
  };
  return {
    async record(k, fields) {
      const { error } = await client.from("proposal_details").upsert({ ...k, ...fields }, { onConflict: "network,orbit_id,proposal_id", ignoreDuplicates: true });
      if (error) fail("Couldn't record the proposal page", error);
    },
    async read(k) {
      const { data, error } = await client.from("proposal_details").select("*").match(k).maybeSingle();
      if (error) fail("Couldn't read the proposal page", error);
      return data;
    },
    async firstUpload(k, fields) {
      const { data, error } = await client.from("proposal_details").update(fields).match(k).is("title", null).select("proposal_id");
      if (error) fail("Couldn't save the details", error);
      return data.length > 0;
    },
    async edit(k, basedOn, fields) {
      const { data, error } = await client.from("proposal_details").update(fields).match({ ...k, content_hash: basedOn }).select("proposal_id");
      if (error) fail("Couldn't save the details", error);
      return data.length > 0;
    },
    async update(k, fields) {
      const { error } = await client.from("proposal_details").update(fields).match(k);
      if (error) fail("Couldn't update the proposal page", error);
    },
    async versions(k) {
      const { data, error } = await client.from("proposal_detail_versions").select("version, title, summary, body, links, content_hash, saved_at").match(k).order("version");
      if (error) fail("Couldn't read the versions", error);
      return data ?? [];
    },
    async addVersion(k, row) {
      const { error } = await client.from("proposal_detail_versions").insert({ ...k, ...row });
      if (error) fail(`Couldn't record version ${row.version}`, error);
    },
  };
}

/** The same in memory, for tests and the sandbox. */
export function memoryPageStore() {
  const rows = new Map();
  const versions = new Map();
  const id = (k) => `${k.network}|${k.orbit_id}|${k.proposal_id}`;
  return {
    async record(k, fields) {
      if (!rows.has(id(k))) rows.set(id(k), { ...k, ...fields, title: null, links: [], version_count: 1, password_failures: 0, created_at: new Date().toISOString() });
    },
    read: async (k) => (rows.has(id(k)) ? { ...rows.get(id(k)) } : null),
    async firstUpload(k, fields) {
      const row = rows.get(id(k));
      if (!row || row.title) return false;
      Object.assign(row, fields);
      return true;
    },
    async edit(k, basedOn, fields) {
      const row = rows.get(id(k));
      if (!row || row.content_hash !== basedOn) return false;
      Object.assign(row, fields);
      return true;
    },
    async update(k, fields) {
      Object.assign(rows.get(id(k)) ?? {}, fields);
    },
    versions: async (k) => [...(versions.get(id(k)) ?? [])],
    async addVersion(k, row) {
      versions.set(id(k), [...(versions.get(id(k)) ?? []), { ...row, saved_at: new Date().toISOString() }]);
    },
    /** Tests: moves a page's creation time back by `hours`. */
    age(k, hours) {
      const row = rows.get(id(k));
      row.created_at = new Date(new Date(row.created_at).getTime() - hours * 3_600_000).toISOString();
    },
  };
}

let memoryStore = null;
let supabase = null;
const store = () => memoryStore ?? (supabase ??= supabaseStore());

/** Keeps details in memory instead of Supabase (tests, the sandbox); returns the store. */
export function usePageStore(s = memoryPageStore()) {
  memoryStore = s;
  return s;
}

const key = (account, id) => ({ network: PAGE_NETWORK, orbit_id: account, proposal_id: String(id) });
const pageRow = (ctx, link) => ({ dao_id: link.daoId, orbit_type: link.model, chat_platform: ctx.platform });

function contentHash({ title, summary, body, links }) {
  return crypto.createHash("sha256").update(JSON.stringify([title, summary, body, links])).digest("hex");
}

/*//////////////////////////////////////////////////////////////
                        EDIT PASSWORD
//////////////////////////////////////////////////////////////*/

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const scrypt = (password, salt, { N, r, p, keylen }) =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, k) => (err ? reject(err) : resolve(k))));

/** "scrypt$N$r$p$salt$hash": only this is stored, never the password. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored ?? "").split("$");
  if (kind !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const given = await scrypt(String(password ?? ""), Buffer.from(salt, "base64url"), { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length });
  return crypto.timingSafeEqual(given, expected);
}

function cleanPassword(v) {
  const s = typeof v === "string" ? v : "";
  if (s.length < PASSWORD.min) throw new Error(`Choose an edit password of at least ${PASSWORD.min} characters - you'll need it to change the details later.`);
  if (s.length > PASSWORD.max) throw new Error(`The password is too long (max ${PASSWORD.max} characters).`);
  return s;
}

/** Validates and cleans what the form sent; throws a message fit to show. */
export function cleanDetails(input) {
  const text = (v, max, name) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length > max) throw new Error(`${name} is too long (max ${max} characters).`);
    return s;
  };
  const title = text(input?.title, LIMITS.title, "Title");
  if (!title) throw new Error("A title is required.");
  const summary = text(input?.summary, LIMITS.summary, "Summary");
  const body = text(input?.body, LIMITS.body, "Details");
  const links = Array.isArray(input?.links) ? input.links : [];
  if (links.length > LIMITS.links) throw new Error(`At most ${LIMITS.links} links.`);
  const cleanLinks = links.map((l) => ({ label: text(l?.label, 80, "Link label"), url: text(l?.url, LIMITS.link, "Link") })).filter((l) => l.url);
  for (const l of cleanLinks) {
    let u;
    try {
      u = new URL(l.url);
    } catch {
      throw new Error(`"${l.url}" isn't a link.`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Links must start with https://");
  }
  return { title, summary, body, links: cleanLinks };
}

/*//////////////////////////////////////////////////////////////
                    AFTER PROPOSING (bot side)
//////////////////////////////////////////////////////////////*/

const editMessage = (id, edit, page, cmd) =>
  `📝 Add the details for proposal #${id} - a title, summary and links: [open your edit page](${edit}) (only you have this link).\n\n` +
  `With the first upload you choose an edit password: any later change needs this link and that password, and every version stays visible on the page. ${windowText()} ` +
  `Everyone sees them on the [proposal page](${page}). Lost this link? \`${cmd("proposal")} ${id}\` sends it again.`;

const reEditMessage = (id, edit, page) =>
  `📝 [Your edit page for proposal #${id}](${edit}) (only you have this link).\n\nChanges need the edit password you chose. Every version stays visible on the [proposal page](${page}). ${windowText()}`;

/** Telegram /start payload that sends a proposer their link again (deep links allow [A-Za-z0-9_-]). */
export const startPayload = (chatId, id) => `pe_${chatId}_${id}`;

/**
 * Right after a proposal is made: records its page and returns the private
 * message for the proposer ({ text, start }), or null when pages aren't set
 * up. Never throws: a page problem mustn't hide that the proposal went through.
 */
export async function proposalCreated(ctx, link, id) {
  if (!proposalPagesConfigured()) return null;
  try {
    await store().record(key(pageAccount(link), id), pageRow(ctx, link));
  } catch (err) {
    console.error("[proposalPages]", err.message);
    return null;
  }
  const text = editMessage(id, editUrl(link, id, ctx.platform, ctx.userId), proposalPageUrl(link, id), ctx.cmd);
  return { text, start: startPayload(ctx.chatId, id) };
}

/**
 * The edit link again ({ text, start }), but only while it's useful: the
 * caller must be the proposal's proposer and the details still open.
 * Otherwise null, and callers stay quiet. Never throws.
 */
export async function pendingEditLink(ctx, link, id) {
  if (!proposalPagesConfigured() || !pageAccount(link)) return null;
  try {
    const me = await services.wallets.findUserAccountId(ctx.platform, ctx.userId);
    if (!me) return null;
    const live = await liveProposal(link, id);
    if (!live || live.proposer !== me) return null;
    const k = key(pageAccount(link), id);
    // Proposals made outside the bot get their page here.
    await store().record(k, pageRow(ctx, link));
    const row = await store().read(k);
    const edit = editUrl(link, id, ctx.platform, ctx.userId);
    const page = proposalPageUrl(link, id);
    const text = submittable(row, live) ? editMessage(id, edit, page, ctx.cmd) : editable(row, live) ? reEditMessage(id, edit, page) : null;
    return text ? { text, start: startPayload(ctx.chatId, id) } : null;
  } catch (err) {
    console.error("[proposalPages]", err.message);
    return null;
  }
}

/** Telegram: `/start pe_<chat>_<id>` from a proposer the bot couldn't message first. The DM's reply. */
export async function editLinkFromStart(payload, ctx) {
  const m = /^pe_(-?\d+)_(\d+)$/.exec(String(payload ?? ""));
  if (!m) return null;
  const [, chatId, id] = m;
  const link = services.db.getChatDao("telegram", chatId);
  if (!link) return "That chat isn't linked to a DAO any more.";
  const found = await pendingEditLink({ ...ctx, chatId }, link, id);
  return found?.text ?? `There's nothing for you to edit on proposal #${id}: only its proposer can, while the details are still open.`;
}

/*//////////////////////////////////////////////////////////////
                            LIVE DATA
//////////////////////////////////////////////////////////////*/

function linkedChats() {
  return ["telegram", "discord"].flatMap((platform) => services.db.chatsOn(platform).map(([, link]) => link));
}

/**
 * The chat link whose proposals live in `account`, or null: only DAOs
 * linked to a chat are served. An orbit the DAO has swapped away from
 * still counts, with its own model, so its old pages stay readable.
 */
async function findDao(account) {
  const links = linkedChats();
  const current = links.find((l) => pageAccount(l) === account);
  if (current) return current;
  const daoId = await services.orbit.getDao(account).catch(() => null);
  const link = daoId && links.find((l) => l.daoId === daoId && l.orbitId);
  if (!link) return null;
  const { name } = services.orbit.modelOf(await services.orbit.getModel(account));
  return { ...link, orbitId: account, model: name };
}

const seconds = (ns) => (ns && BigInt(ns) > 0n ? Number(BigInt(ns) / 1_000_000_000n) : null);
const plain = (text) => String(text).replace(/[`*]/g, "");

/** What /proposal shows, as data the page renders (null if there's no such proposal). */
async function liveProposal(link, id) {
  const token = await tokenInfo(link);
  const board = link.model === "board";
  const p = board ? await services.core.getCoreProposal(link.daoId, id).catch(() => null) : await services.orbit.getProposal(link.orbitId, id).catch(() => null);
  if (!p) return null;
  await services.tokens.load(kindTokens(p.kind));
  const action = describeKind(p.kind, { formatNear, formatToken: (t, amount) => (t === token.id ? token.format(amount) : services.tokens.format(t, amount)) });
  const facts = [];
  const times = [];
  let started;
  if (board) {
    const [approve = "0", reject = "0"] = p.vote_counts?.governance ?? [];
    facts.push({ label: "Approve", value: String(approve) }, { label: "Reject", value: String(reject) });
    times.push({ label: "Submitted", at: seconds(p.submission_time) });
    started = Object.keys(p.votes ?? {}).length > 0;
  } else {
    const fmt = token.format;
    if (link.model === "conviction") {
      facts.push({ label: "Conviction", value: fmt(p.conviction) }, { label: "Needed", value: fmt(p.required_conviction) }, { label: "Backed by", value: fmt(p.support) });
    } else {
      const unit = link.model === "delegate" || link.model === "sortition" ? String : link.model === "quadratic" ? (v) => `${v} (√ weight)` : fmt;
      facts.push({ label: "For", value: unit(p.for_votes) }, { label: "Against", value: unit(p.against_votes) }, { label: "Abstain", value: unit(p.abstain_votes) }, { label: "Voters", value: String(p.voters) });
      times.push({ label: "Voting opens", at: seconds(p.start) }, { label: p.state === "ChallengeWindow" ? "Challenges close" : "Voting ends", at: seconds(p.end) });
    }
    if (p.challenger) facts.push({ label: "Challenged by", value: p.challenger, address: true });
    let backed = false;
    if (link.model === "sowellian") {
      const bet = await services.orbit.getBet(link.orbitId, id).catch(() => null);
      if (bet) {
        facts.push({ label: "Backing YES", value: fmt(bet.yes_pool) }, { label: "Backing NO", value: fmt(bet.no_pool) });
        if (bet.outcome) facts.push({ label: "Outcome", value: bet.outcome });
        times.push({ label: "Measuring until", at: seconds(bet.measurement_deadline) });
        backed = BigInt(bet.yes_pool) + BigInt(bet.no_pool) > 0n;
      }
    }
    if (p.core_proposal_id !== null && p.core_proposal_id !== undefined) facts.push({ label: "On the DAO", value: `proposal ${p.core_proposal_id}` });
    times.push({ label: "Executable from", at: seconds(p.executable_after) });
    started = p.voters > 0 || BigInt(p.support ?? 0) > 0n || Boolean(p.challenger) || backed;
  }
  return {
    network: PAGE_NETWORK,
    chain: CHAIN_NAME,
    explorer: NETWORK_ID === "sandbox" ? null : EXPLORER_URL,
    nativeSymbol: "NEAR",
    model: link.model,
    dao: link.daoId,
    id: String(id),
    state: board ? p.status : p.state,
    description: readable(p.description),
    proposer: p.proposer ?? null,
    facts,
    times: times.filter((t) => t.at),
    actions: [{ label: plain(action) }],
    started,
  };
}

/** Details can change in the grace period, or while nobody has voted or backed it (up to EDIT_WINDOW_HOURS). */
function windowOpen(row, live) {
  if (!row) return false;
  const age = Date.now() - new Date(row.created_at).getTime();
  if (age >= EDIT_WINDOW_HOURS * 3_600_000) return false;
  return age < graceHours() * 3_600_000 || !live.started;
}

const submittable = (row, live) => Boolean(row && !row.title && windowOpen(row, live));
const editable = (row, live) => Boolean(row?.title && row.edit_password_hash && windowOpen(row, live) && (row.version_count ?? 1) < MAX_VERSIONS);

const versionView = (v) => ({ version: v.version, savedAt: v.saved_at, contentHash: v.content_hash, title: v.title, summary: v.summary, body: v.body, links: v.links ?? [] });

/** Checks the URL's parts; the DAO's chat link, or an { status, body } answer. */
async function lookUp(network, account, id) {
  if (network !== PAGE_NETWORK || !ACCOUNT_ID.test(String(account)) || !/^\d{1,18}$/.test(String(id))) return { status: 400, body: { error: "Bad proposal address." } };
  const link = await findDao(account);
  return link ?? { status: 404, body: { error: "This bot doesn't know that DAO." } };
}

/** GET: details + live data for one proposal. */
export async function getProposalPage(network, account, id) {
  const link = await lookUp(network, account, id);
  if (link.status) return link;
  const live = await liveProposal(link, id);
  if (!live) return { status: 404, body: { error: `There's no proposal #${id}.` } };
  const k = key(account, id);
  const row = await store().read(k);
  const details = row?.title ? { title: row.title, summary: row.summary, body: row.body, links: row.links ?? [], updatedAt: row.updated_at, contentHash: row.content_hash } : null;
  const history = row?.title ? (await store().versions(k)).map(versionView) : [];
  return {
    status: 200,
    body: { live, details, history, submittable: submittable(row, live), editable: editable(row, live), passwordMinLength: PASSWORD.min, detailsWindow: { graceHours: graceHours(), windowHours: EDIT_WINDOW_HOURS } },
  };
}

const tooLate = () => `It's too late: the first ${graceHours()} hours are over and people have started voting on or backing this proposal, or the ${EDIT_WINDOW_HOURS}-hour window has closed.`;

/** POST: the proposer saves the form. */
export async function saveProposalPage(network, account, id, input) {
  const link = await lookUp(network, account, id);
  if (link.status) return link;
  if (!verifyEditToken(input?.token, { account, id })) return { status: 403, body: { error: "This edit link isn't valid or has expired." } };
  const live = await liveProposal(link, id);
  if (!live) return { status: 404, body: { error: `There's no proposal #${id}.` } };
  let details;
  try {
    details = cleanDetails(input);
  } catch (err) {
    return { status: 400, body: { error: err.message } };
  }
  const k = key(account, id);
  const row = await store().read(k);
  return row?.title ? editDetails(k, row, live, details, input) : firstUpload(k, row, live, details, input);
}

async function firstUpload(k, row, live, details, input) {
  if (!submittable(row, live)) return { status: 409, body: { error: `${tooLate()} Details can't be added now.` } };
  let password;
  try {
    password = cleanPassword(input?.password);
  } catch (err) {
    return { status: 400, body: { error: err.message } };
  }
  const hash = contentHash(details);
  const written = await store().firstUpload(k, { ...details, content_hash: hash, edit_password_hash: await hashPassword(password), version_count: 1, updated_at: new Date().toISOString() });
  if (!written) return { status: 409, body: { error: "The details were just uploaded from somewhere else - reload the page." } };
  await store().addVersion(k, { version: 1, ...details, content_hash: hash });
  return { status: 200, body: { ok: true, version: 1, contentHash: hash } };
}

async function editDetails(k, row, live, details, input) {
  if (!row.edit_password_hash) return { status: 409, body: { error: "These details can't be changed." } };
  if (!windowOpen(row, live)) return { status: 409, body: { error: `${tooLate()} The details are final.` } };
  if ((row.version_count ?? 1) >= MAX_VERSIONS) return { status: 409, body: { error: `This proposal already has ${MAX_VERSIONS} versions - the most allowed.` } };
  if (row.password_locked_until && new Date(row.password_locked_until) > new Date()) {
    return { status: 429, body: { error: `Too many wrong passwords - try again after ${new Date(row.password_locked_until).toISOString().slice(11, 16)} UTC.` } };
  }
  if (!(await checkPassword(input?.password, row.edit_password_hash))) {
    const failures = (row.password_failures ?? 0) + 1;
    const lock = failures >= PASSWORD.failuresBeforeLock;
    await store().update(k, { password_failures: lock ? 0 : failures, password_locked_until: lock ? new Date(Date.now() + PASSWORD.lockMinutes * 60_000).toISOString() : row.password_locked_until ?? null });
    return { status: 403, body: { error: lock ? `Wrong password. Editing is locked for ${PASSWORD.lockMinutes} minutes.` : `Wrong password (${PASSWORD.failuresBeforeLock - failures} tries left before a ${PASSWORD.lockMinutes}-minute lock).` } };
  }
  const hash = contentHash(details);
  if (hash === row.content_hash) return { status: 409, body: { error: "Nothing changed." } };
  const version = (row.version_count ?? 1) + 1;
  const written = await store().edit(k, row.content_hash, { ...details, content_hash: hash, version_count: version, password_failures: 0, updated_at: new Date().toISOString() });
  if (!written) return { status: 409, body: { error: "The details changed while you were editing - reload the page and try again." } };
  await store().addVersion(k, { version, ...details, content_hash: hash });
  return { status: 200, body: { ok: true, version, contentHash: hash } };
}

/*//////////////////////////////////////////////////////////////
                            HTTP
//////////////////////////////////////////////////////////////*/

const hits = new Map();
/** At most `max` requests per minute per address, per kind. */
function rateLimited(req, kind, max) {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
  const k = `${kind}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(k) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(k, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > max;
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": siteUrl() ? new URL(siteUrl()).origin : "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Not JSON."));
      }
    });
    req.on("error", reject);
  });
}

async function handle(req, res, { network, account, id }) {
  try {
    if (req.method === "OPTIONS") return send(res, 204);
    if (!proposalPagesConfigured()) return send(res, 503, { error: "Proposal pages aren't set up on this bot." });
    if (req.method === "GET") {
      if (rateLimited(req, "get", 120)) return send(res, 429, { error: "Too many requests." });
      const { status, body } = await getProposalPage(network, account, id);
      return send(res, status, body);
    }
    if (req.method === "POST") {
      if (rateLimited(req, "post", 20)) return send(res, 429, { error: "Too many requests." });
      const input = await readJson(req).catch(() => null);
      if (!input) return send(res, 400, { error: "Send the form as JSON." });
      const { status, body } = await saveProposalPage(network, account, id, input);
      return send(res, status, body);
    }
    return send(res, 405, { error: "Method not allowed." });
  } catch (err) {
    console.error("[proposalPages]", err);
    return send(res, 500, { error: "Something went wrong." });
  }
}

/**
 * The API on a plain HTTP server: /api/proposals/<network>/<account>/<id>,
 * plus GET /health for the host. Started by main.js when pages are set up.
 */
export async function startProposalApi(port) {
  const { createServer } = await import("node:http");
  const re = /^\/api\/proposals\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    const m = re.exec(pathname);
    if (!m) {
      res.writeHead(404);
      return res.end();
    }
    let parts;
    try {
      parts = { network: decodeURIComponent(m[1]), account: decodeURIComponent(m[2]), id: decodeURIComponent(m[3]) };
    } catch {
      return send(res, 400, { error: "Bad proposal address." });
    }
    return handle(req, res, parts);
  });
  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`[http] Proposal pages API on port ${port}`);
  return server;
}
