import { createClient } from "@supabase/supabase-js";
import { supabaseMessage, supabaseUrl } from "./supabaseError.js";
import { createEncryptedKey, decryptKey, isKmsWalletConfigured, encryptSecret, decryptSecret } from "./kmsWallet.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Supabase storage for users' NEAR account keys (the `wallets` table in
 * supabase/schema.sql). A lost row is a lost account, so this must be
 * durable storage, not a file on a volume.
 */

const SUPABASE_URL = supabaseUrl();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set on this bot instance");
  }
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  return supabase;
}

export function isWalletStoreConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) && isKmsWalletConfigured();
}

/** This user's wallet row, or null. Decrypts nothing. */
export async function findWalletRecord(platform, platformUserId) {
  const { data, error } = await getSupabaseClient()
    .from("wallets")
    .select("*")
    .eq("platform", platform)
    .eq("platform_user_id", String(platformUserId))
    .maybeSingle();
  if (error) throw new Error(`Supabase lookup failed: ${supabaseMessage(error)}`);
  return data;
}

/**
 * Generates and stores a key for `accountId`, which doesn't exist on chain
 * yet. Stored first, created on chain after, so a key is never lost to a
 * failed write. If two first uses race, the row that landed wins and is
 * returned.
 */
export async function createWalletRecord(platform, platformUserId, accountId) {
  const key = await createEncryptedKey();
  const { error } = await getSupabaseClient().from("wallets").insert({
    platform,
    platform_user_id: String(platformUserId),
    account_id: accountId,
    public_key: key.publicKey,
    encrypted_private_key: key.encryptedPrivateKey,
    encrypted_data_key: key.encryptedDataKey,
    iv: key.iv,
    auth_tag: key.authTag,
  });
  // 23505: unique violation - another process created this user's row first.
  if (error && error.code !== "23505") throw new Error(`Supabase insert failed: ${supabaseMessage(error)}`);
  return findWalletRecord(platform, platformUserId);
}

/** The row's key as an "ed25519:..." string, decrypted for one use. */
export function walletKey(record) {
  return decryptKey({
    encryptedPrivateKey: record.encrypted_private_key,
    encryptedDataKey: record.encrypted_data_key,
    iv: record.iv,
    authTag: record.auth_tag,
  });
}

// --- Hyperliquid agents the bot holds for DAOs ---
//
// A DAO that approves the bot as its Hyperliquid agent gets an EVM key the
// bot generated, kept in the same table, encrypted the same way: platform
// "hyperliquid", keyed by the DAO's account, its address as the public key.
// The key can trade for the DAO's Hyperliquid account; it can't withdraw.

const AGENT_PLATFORM = "hyperliquid";

/** The DAO's agent { address, privateKey() }, generating and storing a key the first time. */
export async function getOrCreateAgentKey(daoId) {
  let record = await findWalletRecord(AGENT_PLATFORM, daoId);
  if (!record) {
    const privateKey = generatePrivateKey();
    const secret = await encryptSecret(privateKey);
    const { error } = await getSupabaseClient().from("wallets").insert({
      platform: AGENT_PLATFORM,
      platform_user_id: daoId,
      account_id: `hyperliquid-agent:${daoId}`,
      public_key: privateKeyToAccount(privateKey).address,
      encrypted_private_key: secret.ciphertext,
      encrypted_data_key: secret.encryptedDataKey,
      iv: secret.iv,
      auth_tag: secret.authTag,
    });
    if (error && error.code !== "23505") throw new Error(`Supabase insert failed: ${supabaseMessage(error)}`);
    record = await findWalletRecord(AGENT_PLATFORM, daoId);
  }
  return {
    address: record.public_key,
    privateKey: () => decryptSecret({ ciphertext: record.encrypted_private_key, encryptedDataKey: record.encrypted_data_key, iv: record.iv, authTag: record.auth_tag }),
  };
}

/** The DAO's agent address, or null if the bot holds none for it. */
export async function findAgentAddress(daoId) {
  return (await findWalletRecord(AGENT_PLATFORM, daoId))?.public_key ?? null;
}
