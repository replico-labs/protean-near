/**
 * NEAR settings, from the environment (.env.example lists them).
 */

const NETWORKS = {
  testnet: {
    rpcUrl: "https://rpc.testnet.near.org",
    explorer: "https://testnet.nearblocks.io",
    sputnikFactory: "sputnikv2.testnet",
  },
  mainnet: {
    rpcUrl: "https://rpc.mainnet.near.org",
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

export const RPC_URL = process.env.NEAR_RPC_URL || network.rpcUrl;
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
