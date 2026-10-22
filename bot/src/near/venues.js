import { NETWORK_ID } from "../config.js";

/**
 * Where a DAO's treasury can go on NEAR, per network: Rhea (formerly Ref)
 * for swaps, the wrapped-NEAR contract it trades NEAR through, the liquid
 * staking protocols, and token symbols people can type.
 *
 * Mainnet IDs are the protocols' published accounts. Testnet IDs are their
 * testnet deployments; check them before relying on them. Every ID can be
 * set from the environment, which is how the sandbox points at its copies.
 */

const DEFAULTS = {
  mainnet: {
    rhea: "v2.ref-finance.near",
    wrapNear: "wrap.near",
    lst: { linear: "linear-protocol.near", metapool: "meta-pool.near", nearx: "v2-nearx.stader-labs.near" },
    tokens: { USDC: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", USDT: "usdt.tether-token.near" },
  },
  testnet: {
    rhea: "ref-finance-101.testnet",
    wrapNear: "wrap.testnet",
    lst: { linear: "linear-protocol.testnet", metapool: "meta-v2.pool.testnet", nearx: "v2-nearx.staderlabs.testnet" },
    tokens: {},
  },
  sandbox: { rhea: null, wrapNear: null, lst: {}, tokens: {} },
};

function fromEnv() {
  const base = DEFAULTS[NETWORK_ID] ?? DEFAULTS.testnet;
  const lst = { ...base.lst };
  if (process.env.LINEAR_ID) lst.linear = process.env.LINEAR_ID;
  if (process.env.METAPOOL_ID) lst.metapool = process.env.METAPOOL_ID;
  if (process.env.NEARX_ID) lst.nearx = process.env.NEARX_ID;
  return {
    rhea: process.env.RHEA_EXCHANGE_ID || base.rhea,
    wrapNear: process.env.WRAP_NEAR_ID || base.wrapNear,
    lst,
    // KNOWN_TOKENS='{"USDC":"usdc.example.near"}' adds or replaces symbols.
    tokens: { ...base.tokens, ...JSON.parse(process.env.KNOWN_TOKENS || "{}") },
  };
}

export const VENUES = fromEnv();

/** Liquid staking providers, as people type them. */
export const LST_NAMES = { linear: "LiNEAR", metapool: "Meta Pool", nearx: "Stader (NearX)" };
