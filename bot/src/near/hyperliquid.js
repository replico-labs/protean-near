import { hashTypedData, recoverAddress } from "viem";
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

/** The DAO's account: { accountValue, withdrawable, positions: [{ coin, size, value }] }. */
export async function account(address) {
  const state = await post("/info", { type: "clearinghouseState", user: address });
  return {
    accountValue: state.marginSummary?.accountValue ?? "0",
    withdrawable: state.withdrawable ?? "0",
    positions: (state.assetPositions ?? []).map((p) => ({ coin: p.position.coin, size: p.position.szi, value: p.position.positionValue })),
  };
}
