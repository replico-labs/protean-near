/**
 * NEAR settings, from the environment (.env.example lists them).
 */

const NETWORKS = {
  testnet: {
    // Free public RPCs that need no key (dRPC, then Intear); NEAR's own rpc.*.near.org is
    // deprecated and rate-limited. Each request falls back to the next if one fails.
    rpcUrl: "https://near-testnet.drpc.org,https://testnet-rpc.intea.rs",
    explorer: "https://testnet.nearblocks.io",
    sputnikFactory: "sputnikv2.testnet",
  },
  mainnet: {
    rpcUrl: "https://near.drpc.org,https://rpc.intea.rs",
    explorer: "https://nearblocks.io",
    sputnikFactory: "sputnik-dao.near",
  },
  // A local NEAR node (near-sandbox) set up by scripts/sandbox-setup.js
  sandbox: {
    rpcUrl: "http://127.0.0.1:3030",
    explorer: "http://127.0.0.1:3030",
    sputnikFactory: "sputnikv2.test.near",
  },
};

export const NETWORK_ID = process.env.NEAR_NETWORK || "testnet";
if (!NETWORKS[NETWORK_ID]) throw new Error(`NEAR_NETWORK must be "testnet", "mainnet" or "sandbox", not "${NETWORK_ID}"`);
const network = NETWORKS[NETWORK_ID];

/** NEAR_RPC_URL may list several RPCs, comma-separated: each request goes to the next when one fails. */
export const RPC_URLS = (process.env.NEAR_RPC_URL || network.rpcUrl).split(",").map((u) => u.trim()).filter(Boolean);
export const RPC_URL = RPC_URLS[0];
export const EXPLORER_URL = network.explorer;
export const SPUTNIK_FACTORY_ID = process.env.SPUTNIK_FACTORY_ID || network.sputnikFactory;

/** Pays account creation and gas top-ups, and is the parent of every user account. */
export const OPERATOR_ACCOUNT_ID = process.env.NEAR_OPERATOR_ACCOUNT_ID;
export const OPERATOR_PRIVATE_KEY = process.env.NEAR_OPERATOR_PRIVATE_KEY;

/** NEAR given to each new user account: its storage plus gas for its first actions. */
export const NEW_ACCOUNT_NEAR = process.env.NEW_ACCOUNT_NEAR || "0.05";
/** Below this much available NEAR, a user account is topped back up to NEW_ACCOUNT_NEAR first. */
export const MIN_ACCOUNT_NEAR = process.env.MIN_ACCOUNT_NEAR || "0.02";

export const MAX_GAS = 300_000_000_000_000n;
/**
 * For a call that makes no calls of its own (a storage deposit, a plain
 * token transfer). NEAR holds attached gas at ten times its price until the
 * call ends, so a small call keeps 0.03 NEAR busy instead of MAX_GAS's 0.3.
 */
export const SIMPLE_GAS = 30_000_000_000_000n;
