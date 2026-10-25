import { encode as msgpack } from "@msgpack/msgpack";
import { hashTypedData, recoverAddress, keccak256, concat, numberToBytes, parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORK_ID } from "../config.js";

/**
 * Hyperliquid for the DAO's own EVM address (Chain Signatures). The DAO
 * acts with Hyperliquid's user-signed actions: EIP-712 messages its key
 * signs by proposal, which the bot then posts. Formats follow Hyperliquid's
 * Python SDK (hyperliquid/utils/signing.py).
 *
 * The DAO appoints a trading agent (`approveAgent`): an address that can
 * place and cancel orders for the DAO's account but can't withdraw. Moving
 * money out (`usdSend`) always takes a proposal.
 */

const DAY_MS = 86_400_000;
/** Hyperliquid accepts a nonce from two days before its clock to one day after. */
const NONCE_LEAD_MS = DAY_MS - 3_600_000;
const NONCE_WINDOW_MS = 2 * DAY_MS;

export function api() {
  return process.env.HYPERLIQUID_API || (NETWORK_ID === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz");
}

const hyperliquidChain = () => (NETWORK_ID === "mainnet" ? "Mainnet" : "Testnet");

async function post(path, body) {
  const res = await fetch(`${api()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`Hyperliquid: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

const TYPES = {
  approveAgent: {
    primaryType: "HyperliquidTransaction:ApproveAgent",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "agentAddress", type: "address" },
      { name: "agentName", type: "string" },
      { name: "nonce", type: "uint64" },
    ],
  },
  usdClassTransfer: {
    primaryType: "HyperliquidTransaction:UsdClassTransfer",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "amount", type: "string" },
      { name: "toPerp", type: "bool" },
      { name: "nonce", type: "uint64" },
    ],
  },
  usdSend: {
    primaryType: "HyperliquidTransaction:UsdSend",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
  },
};

/** The EIP-712 digest the DAO's key signs for `action`. */
export function digest(action) {
  const { primaryType, fields } = TYPES[action.type];
  return hashTypedData({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: Number.parseInt(action.signatureChainId, 16), verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { [primaryType]: fields },
    primaryType,
    message: Object.fromEntries(fields.map((f) => [f.name, f.type === "uint64" ? BigInt(action[f.name]) : action[f.name]])),
  });
}

/**
 * A nonce for an action proposed now, as late as Hyperliquid allows so the
 * vote has the most time; `validUntil` is when Hyperliquid stops accepting it.
 */
export function nonceForProposal(now = Date.now()) {
  const nonce = now + NONCE_LEAD_MS;
  return { nonce, validUntil: new Date(nonce + NONCE_WINDOW_MS - 3_600_000) };
}

const base = (type) => ({ type, signatureChainId: "0x66eee", hyperliquidChain: hyperliquidChain() });

/** Lets `agentAddress` trade (place and cancel orders) for the DAO's account. Same `name`: replaces that agent. */
export const approveAgent = (agentAddress, agentName, nonce) => ({ ...base("approveAgent"), agentAddress, agentName, nonce });

/** Sends `amount` USDC (a decimal string) from the DAO's Hyperliquid account to `destination`. */
export const usdSend = (destination, amount, time) => ({ ...base("usdSend"), destination, amount, time });

/**
 * Moves `amount` USDC (a decimal string) between the DAO's spot balance and
 * its perps balance, which trading uses: `toPerp` true moves it to perps.
 */
export const usdClassTransfer = (amount, toPerp, nonce) => ({ ...base("usdClassTransfer"), amount, toPerp, nonce });

/** The nonce Hyperliquid expects alongside `action`. */
export const nonceOf = (action) => action.nonce ?? action.time;

/** Posts `action` with `signature` ({ r, s, yParity }), after checking it recovers to `from`. */
export async function submit(action, signature, from) {
  const hash = digest(action);
  const signer = await recoverAddress({ hash, signature });
  if (signer.toLowerCase() !== from.toLowerCase()) throw new Error(`Signed by ${signer}, not the DAO's ${from}`);
  const response = await post("/exchange", {
    action,
    nonce: nonceOf(action),
    signature: { r: signature.r, s: signature.s, v: 27 + signature.yParity },
    vaultAddress: null,
  });
  if (response?.status !== "ok") throw new Error(`Hyperliquid: ${JSON.stringify(response?.response ?? response)}`);
  return response;
}

/**
 * The DAO's account: its perps balance, which trading uses ({ accountValue,
 * withdrawable, positions: [{ coin, size, value }] }), and the USDC in its
 * separate spot balance (`spotUsdc`).
 */
export async function account(address) {
  const [state, spot] = await Promise.all([post("/info", { type: "clearinghouseState", user: address }), post("/info", { type: "spotClearinghouseState", user: address }).catch(() => null)]);
  return {
    accountValue: state.marginSummary?.accountValue ?? "0",
    withdrawable: state.withdrawable ?? "0",
    positions: (state.assetPositions ?? []).map((p) => ({ coin: p.position.coin, size: p.position.szi, value: p.position.positionValue })),
    spotUsdc: spot?.balances?.find((b) => b.coin === "USDC")?.total ?? "0",
  };
}

// --- Trading through a bot-held agent ---
//
// The DAO can approve an agent whose key the bot holds (encrypted with KMS),
// so its named traders trade from the chat within limits the DAO set. An
// agent signs Hyperliquid's L1 actions (orders, leverage) for the DAO's
// account; it can never withdraw. Formats and hashing follow the Python
// SDK (signing.py: action_hash, construct_phantom_agent, l1_payload).

/** What an agent signs for L1 `action` at `nonce`: the "phantom agent" EIP-712 message over the action's hash. */
export function l1Digest(action, nonce, mainnet = NETWORK_ID === "mainnet") {
  const connectionId = keccak256(concat([msgpack(action), numberToBytes(BigInt(nonce), { size: 8 }), new Uint8Array([0])]));
  return hashTypedData({
    domain: { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: mainnet ? "a" : "b", connectionId },
  });
}

/** Signs L1 `action` with the agent's `privateKey` and posts it. Returns Hyperliquid's `response`. */
export async function sendL1(privateKey, action) {
  const nonce = Date.now();
  const signature = parseSignature(await privateKeyToAccount(privateKey).sign({ hash: l1Digest(action, nonce) }));
  const response = await post("/exchange", { action, nonce, signature: { r: signature.r, s: signature.s, v: Number(signature.v) }, vaultAddress: null });
  if (response?.status !== "ok") throw new Error(`Hyperliquid: ${typeof response?.response === "string" ? response.response : JSON.stringify(response?.response ?? response)}`);
  return response.response;
}

let marketsCache = null;
/** Perp markets by coin: { asset (index), szDecimals, maxLeverage }; re-read every 10 minutes. */
export async function markets() {
  if (!marketsCache || Date.now() - marketsCache.at > 600_000) {
    const { universe } = await post("/info", { type: "meta" });
    const byCoin = {};
    universe.forEach((m, asset) => {
      if (!m.isDelisted) byCoin[m.name.toUpperCase()] = { coin: m.name, asset, szDecimals: m.szDecimals, maxLeverage: m.maxLeverage };
    });
    marketsCache = { at: Date.now(), byCoin };
  }
  return marketsCache.byCoin;
}

/** Mid prices by coin, as numbers. */
export async function mids() {
  return Object.fromEntries(Object.entries(await post("/info", { type: "allMids" })).map(([coin, px]) => [coin, Number(px)]));
}

/** The agents `address` has approved: [{ name, address, validUntil }]. */
export const agents = (address) => post("/info", { type: "extraAgents", user: address });

/** `n` with at most `decimals` decimals, rounded down, as Hyperliquid wants it (no trailing zeros). */
export function wireNumber(n, decimals) {
  const factor = 10 ** decimals;
  const fixed = (Math.floor(n * factor + 1e-9) / factor).toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** A perp price Hyperliquid accepts: at most 5 significant figures and 6 - szDecimals decimals (whole numbers always). */
export function wirePrice(px, szDecimals) {
  if (px >= 1e5) return String(Math.round(px));
  const significant = Number(px.toPrecision(5));
  return wireNumber(significant, Math.max(0, 6 - szDecimals)).replace(/^$/, "0");
}

/** Hyperliquid refuses an order worth less than this, in USD. */
export const MIN_ORDER_USD = 10;

/**
 * The order size for about `usd` of a coin at `mid`, in its size steps
 * (szDecimals). Rounded down, unless that would leave it under
 * MIN_ORDER_USD at the order's own price (a sell's is 1% under the mid),
 * then up by as few steps as it takes.
 */
export function orderSize(usd, mid, szDecimals, isBuy, slippage = 0.01) {
  const step = 10 ** -szDecimals;
  const px = mid * (isBuy ? 1 + slippage : 1 - slippage);
  let size = Number(wireNumber(usd / mid, szDecimals));
  while (size * Math.min(px, mid) < MIN_ORDER_USD && usd >= MIN_ORDER_USD) size = Number((size + step).toFixed(szDecimals));
  return size;
}

/** Sets `asset`'s leverage for the account (cross margin). */
export const updateLeverage = (asset, leverage) => ({ type: "updateLeverage", asset, isCross: true, leverage });

/**
 * A market order: immediate-or-cancel at `slippage` past the mid, so it
 * fills now at the best prices up to that, or not at all.
 */
export function marketOrder({ asset, szDecimals }, isBuy, size, mid, { reduceOnly = false, slippage = 0.01 } = {}) {
  const px = wirePrice(mid * (isBuy ? 1 + slippage : 1 - slippage), szDecimals);
  return { type: "order", orders: [{ a: asset, b: isBuy, p: px, s: wireNumber(size, szDecimals), r: reduceOnly, t: { limit: { tif: "Ioc" } } }], grouping: "na" };
}

/** What an order did, from its `response`: { filled, avgPx } or { error }. */
export function orderResult(response) {
  const status = response?.data?.statuses?.[0] ?? {};
  if (status.filled) return { filled: status.filled.totalSz, avgPx: status.filled.avgPx };
  return { error: status.error ?? (status.resting ? "it didn't fill at once and was left resting" : "no fill") };
}
