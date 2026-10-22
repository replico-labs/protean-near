import { keccak256, getAddress } from "viem";
import { baseDecode } from "near-api-js";
import { NETWORK_ID } from "../config.js";
import { view } from "./client.js";
import * as kinds from "./kinds.js";

/**
 * NEAR Chain Signatures: the DAO's own address on EVM chains. NEAR's signing
 * network (v1.signer) derives a key for every NEAR account and path, and
 * signs with it only when that account asks. So the DAO's EVM address is
 * controlled by its proposals: a passed proposal calls `sign` with a
 * transaction's hash, and the bot sends the signed transaction.
 */

/** One address per DAO, the same on every EVM chain. */
export const PATH = "evm-1";

export function signerId() {
  if (process.env.CHAIN_SIGNER_ID) return process.env.CHAIN_SIGNER_ID;
  const id = { mainnet: "v1.signer", testnet: "v1.signer-prod.testnet" }[NETWORK_ID];
  if (!id) throw new Error(`Chain Signatures isn't configured on ${NETWORK_ID} (CHAIN_SIGNER_ID)`);
  return id;
}

/** The EVM address the signing network derives for `accountId`. */
export async function evmAddress(accountId) {
  const key = await view(signerId(), "derived_public_key", { path: PATH, predecessor: accountId, domain_id: 0 });
  const point = baseDecode(String(key).replace(/^secp256k1:/, ""));
  if (point.length !== 64) throw new Error(`Unexpected derived key ${key}`);
  return getAddress(`0x${keccak256(point).slice(-40)}`);
}

/** A proposal kind that asks the signing network to sign each 32-byte hash (0x-hex), in order. */
export function signKind(hashes) {
  return kinds.functionCall(
    signerId(),
    hashes.map((hash) => ({
      method: "sign",
      args: { request: { path: PATH, payload_v2: { Ecdsa: hash.replace(/^0x/, "") }, domain_id: 0 } },
      deposit: 1n,
      tgas: 50,
    })),
  );
}

/**
 * The signatures a transaction's execution produced, as { r, s, yParity },
 * read from the signing network's receipts in `outcome`.
 */
export function signaturesFrom(outcome) {
  const signer = signerId();
  return (outcome?.receipts_outcome ?? [])
    .filter((r) => r.outcome.executor_id === signer && r.outcome.status?.SuccessValue)
    .map((r) => JSON.parse(Buffer.from(r.outcome.status.SuccessValue, "base64").toString()))
    .filter((s) => s?.big_r?.affine_point && s?.s?.scalar)
    .map((s) => ({
      // R is a compressed point: a parity byte, then r.
      r: `0x${s.big_r.affine_point.slice(2).toLowerCase()}`,
      s: `0x${s.s.scalar.toLowerCase()}`,
      yParity: Number(s.recovery_id),
    }));
}
