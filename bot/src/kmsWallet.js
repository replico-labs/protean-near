import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { KeyPair } from "near-api-js";
import crypto from "crypto";

/**
 * KMS envelope encryption for NEAR account keys, as in the EVM Protean bot.
 *
 * Each user's ed25519 key is generated once and encrypted with its own data
 * key (AES-256-GCM); the data key is wrapped by one shared KMS key. The only
 * copy of a user's key is the encrypted record the caller stores, so a lost
 * record is a lost account: storage must be durable.
 *
 * Every KMS call carries the encryption context {app: "protean-near"}. This
 * bot's IAM user may only use the key with that context, so its credentials
 * can't decrypt the EVM bot's wallets, which share the key without it.
 */

const KMS_KEY_ID = process.env.KMS_KEY_ID;
const AWS_REGION = process.env.AWS_REGION;
export const ENCRYPTION_CONTEXT = Object.freeze({ app: "protean-near" });

let kmsClient = null;
function getKmsClient() {
  if (!kmsClient) kmsClient = new KMSClient({ region: AWS_REGION });
  return kmsClient;
}

export function isKmsWalletConfigured() {
  return Boolean(KMS_KEY_ID && AWS_REGION);
}

function requireKms() {
  if (!isKmsWalletConfigured()) throw new Error("KMS_KEY_ID and AWS_REGION must be set on this bot instance");
}

/**
 * A new ed25519 key pair with its secret envelope-encrypted. Never touches
 * storage; the caller persists the result.
 *
 * @returns {Promise<{publicKey: string, encryptedPrivateKey: string, encryptedDataKey: string, iv: string, authTag: string}>}
 */
export async function createEncryptedKey() {
  requireKms();
  const keyPair = KeyPair.fromRandom("ed25519");
  const { ciphertext, encryptedDataKey, iv, authTag } = await encryptSecret(keyPair.toString());
  return { publicKey: keyPair.getPublicKey().toString(), encryptedPrivateKey: ciphertext, encryptedDataKey, iv, authTag };
}

/**
 * The stored key as an "ed25519:..." string, for one signing operation.
 * Callers use it at once and keep no copy.
 */
export async function decryptKey(record) {
  return decryptSecret({ ...record, ciphertext: record.encryptedPrivateKey });
}

/** Envelope-encrypts any secret string. Returns base64 fields ready to store as text. */
export async function encryptSecret(plaintext) {
  requireKms();
  const { Plaintext: dataKey, CiphertextBlob: wrappedDataKey } = await getKmsClient().send(
    new GenerateDataKeyCommand({ KeyId: KMS_KEY_ID, KeySpec: "AES_256", EncryptionContext: ENCRYPTION_CONTEXT })
  );
  const iv = crypto.randomBytes(12); // 96-bit IV, the standard size for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    encryptedDataKey: Buffer.from(wrappedDataKey).toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Reverses encryptSecret. Pinned to KMS_KEY_ID, so ciphertext under another key is refused. */
export async function decryptSecret(record) {
  requireKms();
  const { Plaintext: dataKey } = await getKmsClient().send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(record.encryptedDataKey, "base64"),
      KeyId: KMS_KEY_ID,
      EncryptionContext: ENCRYPTION_CONTEXT,
    })
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
