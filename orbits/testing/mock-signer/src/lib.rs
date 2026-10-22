//! A sandbox stand-in for NEAR's Chain Signatures contract (`v1.signer`).
//!
//! It has the real contract's `sign`, `public_key` and `derived_public_key`,
//! with the same request and response formats and the same key derivation
//! (crates/contract in github.com/near/mpc): an account's key for a path is
//! the root key plus sha3_256("near-mpc-recovery v0.1.0 epsilon
//! derivation:" + account + "," + path) times the generator. The difference
//! is that one fixed, public test key signs at once, where the real network
//! signs with a key no single party holds. It exists so the bot's Chain
//! Signatures flow can run end to end on a sandbox; it must never be
//! deployed anywhere else.

use k256::ecdsa::SigningKey;
use k256::elliptic_curve::PrimeField;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{ProjectivePoint, Scalar};
use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, env, near, require};
use sha3::{Digest, Sha3_256};

const TWEAK_DERIVATION_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";
/// The test root key: sha3_256 of a public phrase. Anyone can sign with it.
const ROOT_SEED: &str = "protean sandbox chain signatures test key";

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Value,
    pub domain_id: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {}

fn root_scalar() -> Scalar {
    let seed: [u8; 32] = Sha3_256::digest(ROOT_SEED.as_bytes()).into();
    Option::from(Scalar::from_repr(seed.into())).expect("ERR_ROOT_KEY")
}

fn tweak(predecessor: &AccountId, path: &str) -> Scalar {
    let hash: [u8; 32] = Sha3_256::digest(format!("{TWEAK_DERIVATION_PREFIX}{predecessor},{path}").as_bytes()).into();
    Option::from(Scalar::from_repr(hash.into())).expect("ERR_TWEAK")
}

/// NEAR's "secp256k1:<base58 of the 64-byte uncompressed point, without 0x04>".
fn near_public_key(point: ProjectivePoint) -> String {
    let encoded = point.to_affine().to_encoded_point(false);
    format!("secp256k1:{}", near_sdk::bs58::encode(&encoded.as_bytes()[1..]).into_string())
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {}
    }

    pub fn public_key(&self, domain_id: Option<u64>) -> String {
        let _ = domain_id;
        near_public_key(ProjectivePoint::GENERATOR * root_scalar())
    }

    pub fn derived_public_key(&self, path: String, predecessor: Option<AccountId>, domain_id: Option<u64>) -> String {
        let _ = domain_id;
        let predecessor = predecessor.unwrap_or_else(env::predecessor_account_id);
        near_public_key(ProjectivePoint::GENERATOR * (root_scalar() + tweak(&predecessor, &path)))
    }

    /// Signs `request.payload_v2.Ecdsa` (32 bytes, hex) with the caller's key
    /// for `request.path`. Like the real contract, the signature arrives in a
    /// callback receipt of its own (there, when the network resumes the
    /// yielded request), as `{scheme, big_r, s, recovery_id}`.
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> Promise {
        let signature = self.signature(&request);
        Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).return_signature(signature)
    }

    #[private]
    pub fn return_signature(&self, signature: Value) -> Value {
        signature
    }
}

impl Contract {
    fn signature(&self, request: &SignRequest) -> Value {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "Attach 1 yoctoNEAR");
        require!(env::prepaid_gas() >= Gas::from_tgas(15), "Attach at least 15 Tgas");
        require!(request.domain_id.unwrap_or(0) == 0, "Only domain 0 (secp256k1)");
        let payload = request.payload_v2.get("Ecdsa").and_then(Value::as_str).expect("Payload is not Ecdsa");
        let hash: [u8; 32] = hex::decode(payload).ok().and_then(|b| b.try_into().ok()).expect("Payload must be 32 bytes of hex");
        let key = SigningKey::from_bytes(&(root_scalar() + tweak(&env::predecessor_account_id(), &request.path)).to_repr()).unwrap();
        let (signature, recovery_id) = key.sign_prehash_recoverable(&hash).expect("ERR_SIGN");
        let (r, s) = signature.split_bytes();
        // The real contract returns R as a compressed point: its parity, then r.
        let mut big_r = vec![if recovery_id.is_y_odd() { 0x03 } else { 0x02 }];
        big_r.extend_from_slice(&r);
        json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": hex::encode_upper(big_r) },
            "s": { "scalar": hex::encode_upper(s) },
            "recovery_id": recovery_id.to_byte(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    #[test]
    fn signatures_recover_to_the_derived_key() {
        let dao: AccountId = "ark.sputnikv2.testnet".parse().unwrap();
        testing_env!(VMContextBuilder::new().predecessor_account_id(dao.clone()).attached_deposit(NearToken::from_yoctonear(1)).prepaid_gas(Gas::from_tgas(50)).build());
        let mut contract = Contract::new();
        let hash = [7u8; 32];
        let response = contract.signature(&SignRequest { path: "evm-1".into(), payload_v2: json!({ "Ecdsa": hex::encode(hash) }), domain_id: Some(0) });
        let big_r = hex::decode(response["big_r"]["affine_point"].as_str().unwrap()).unwrap();
        let s = hex::decode(response["s"]["scalar"].as_str().unwrap()).unwrap();
        let signature = Signature::from_scalars(<[u8; 32]>::try_from(&big_r[1..]).unwrap(), <[u8; 32]>::try_from(&s[..]).unwrap()).unwrap();
        let recovery_id = RecoveryId::from_byte(response["recovery_id"].as_u64().unwrap() as u8).unwrap();
        let recovered = VerifyingKey::recover_from_prehash(&hash, &signature, recovery_id).unwrap();
        let encoded = recovered.to_encoded_point(false);
        let expected = contract.derived_public_key("evm-1".into(), Some(dao), None);
        assert_eq!(format!("secp256k1:{}", near_sdk::bs58::encode(&encoded.as_bytes()[1..]).into_string()), expected);
        assert_ne!(expected, contract.derived_public_key("evm-2".into(), Some("other.testnet".parse().unwrap()), None), "keys differ by account and path");
    }
}
