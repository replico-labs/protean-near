//! A token migrator: after a DAO changes its token, holders send the old
//! token here and get the new one at a fixed ratio.
//!
//! The new token's initial supply is minted here when it is created (the old
//! supply times the ratio), so every old token can always be swapped. Old
//! tokens that arrive stay here for good.
//!
//! Send the old token with `ft_transfer_call`:
//! - empty message: the new token goes to the sender, who must be
//!   registered with it;
//! - `"stake"`: the new token is staked for the sender in the DAO's new
//!   staking vault, where they must be registered.
//!
//! If the new token can't be delivered, the old token is returned.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, log, near, require};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(50);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const MAX_RESULT_LEN: usize = 1024;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao_id: AccountId,
    old_token: AccountId,
    new_token: AccountId,
    new_vault: AccountId,
    numerator: u128,
    denominator: u128,
    /// Old tokens taken in, and new tokens given out.
    migrated: u128,
    issued: u128,
}

#[near(serializers = [json])]
pub struct MigratorView {
    pub dao_id: AccountId,
    pub old_token: AccountId,
    pub new_token: AccountId,
    pub new_vault: AccountId,
    pub numerator: U128,
    pub denominator: U128,
    pub migrated: U128,
    pub issued: U128,
}

#[near]
impl Contract {
    /// `numerator`/`denominator` new tokens (raw units) per old one.
    #[init]
    pub fn new(
        dao_id: AccountId,
        old_token: AccountId,
        new_token: AccountId,
        new_vault: AccountId,
        numerator: U128,
        denominator: U128,
    ) -> Self {
        require!(numerator.0 > 0 && denominator.0 > 0, "ERR_ZERO_RATIO");
        require!(old_token != new_token, "ERR_SAME_TOKEN");
        Self {
            dao_id,
            old_token,
            new_token,
            new_vault,
            numerator: numerator.0,
            denominator: denominator.0,
            migrated: 0,
            issued: 0,
        }
    }

    /// What `amount` old tokens (raw units) swap for, rounded down.
    pub fn quote(&self, amount: U128) -> U128 {
        U128(self.convert(amount.0))
    }

    /// NEP-141 receiver for the old token.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.old_token, "ERR_WRONG_TOKEN");
        let out = self.convert(amount.0);
        require!(out > 0, "ERR_AMOUNT_TOO_SMALL");
        let send = match msg.as_str() {
            "" => Promise::new(self.new_token.clone()).function_call(
                "ft_transfer",
                json!({ "receiver_id": sender_id, "amount": U128(out), "memo": "token migration" }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            ),
            "stake" => Promise::new(self.new_token.clone()).function_call(
                "ft_transfer_call",
                json!({
                    "receiver_id": self.new_vault,
                    "amount": U128(out),
                    "memo": "token migration",
                    "msg": json!({ "stake_for": sender_id }).to_string(),
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER_CALL,
            ),
            _ => env::panic_str("ERR_INVALID_MESSAGE"),
        };
        PromiseOrValue::Promise(send.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_delivered(sender_id, amount, U128(out), msg == "stake"),
        ))
    }

    /// Keeps the old tokens if the new ones arrived; otherwise returns them
    /// (the unused amount, to the old token).
    #[private]
    pub fn on_delivered(&mut self, sender_id: AccountId, amount: U128, out: U128, staked: bool) -> U128 {
        let delivered = match env::promise_result_checked(0, MAX_RESULT_LEN) {
            // ft_transfer_call answers how much the vault used: all or nothing.
            Ok(bytes) if staked => near_sdk::serde_json::from_slice::<U128>(&bytes).is_ok_and(|used| used.0 == out.0),
            Ok(_) => true,
            Err(_) => false,
        };
        if delivered {
            self.migrated += amount.0;
            self.issued += out.0;
            U128(0)
        } else {
            log!("Couldn't deliver {} new tokens to {}; returning the old ones", out.0, sender_id);
            amount
        }
    }

    pub fn get_info(&self) -> MigratorView {
        MigratorView {
            dao_id: self.dao_id.clone(),
            old_token: self.old_token.clone(),
            new_token: self.new_token.clone(),
            new_vault: self.new_vault.clone(),
            numerator: U128(self.numerator),
            denominator: U128(self.denominator),
            migrated: U128(self.migrated),
            issued: U128(self.issued),
        }
    }
}

impl Contract {
    fn convert(&self, amount: u128) -> u128 {
        // amount × numerator / denominator, without overflowing on the way.
        let (q, r) = (amount / self.denominator, amount % self.denominator);
        q.checked_mul(self.numerator)
            .and_then(|whole| whole.checked_add(r.checked_mul(self.numerator)? / self.denominator))
            .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

    const OLD: &str = "token.ark.protean.testnet";
    const NEW: &str = "nova.ark.protean.testnet";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn call(who: &str, results: Vec<PromiseResult>) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acc("migrator.ark.protean.testnet")).predecessor_account_id(acc(who));
        testing_env!(ctx.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }

    fn migrator(numerator: u128, denominator: u128) -> Contract {
        call("deployer.testnet", vec![]);
        Contract::new(
            acc("ark.sputnik.protean.testnet"),
            acc(OLD),
            acc(NEW),
            acc("staking2.ark.protean.testnet"),
            U128(numerator),
            U128(denominator),
        )
    }

    #[test]
    fn quotes_at_the_ratio_rounding_down() {
        assert_eq!(migrator(1, 1).quote(U128(500)).0, 500);
        assert_eq!(migrator(3, 2).quote(U128(5)).0, 7);
        assert_eq!(migrator(1, 1000).quote(U128(1999)).0, 1);
        // Large amounts don't overflow on the way.
        let big = 10u128.pow(36);
        assert_eq!(migrator(7, 3).quote(U128(big)).0, big / 3 * 7 + (big % 3) * 7 / 3);
    }

    #[test]
    #[should_panic(expected = "ERR_WRONG_TOKEN")]
    fn only_the_old_token_is_taken() {
        let mut m = migrator(1, 1);
        call(NEW, vec![]);
        let _ = m.ft_on_transfer(acc("alice.testnet"), U128(5), String::new());
    }

    #[test]
    #[should_panic(expected = "ERR_AMOUNT_TOO_SMALL")]
    fn dust_that_swaps_for_nothing_is_refused() {
        let mut m = migrator(1, 1000);
        call(OLD, vec![]);
        let _ = m.ft_on_transfer(acc("alice.testnet"), U128(999), String::new());
    }

    #[test]
    #[should_panic(expected = "ERR_INVALID_MESSAGE")]
    fn unknown_messages_are_refused() {
        let mut m = migrator(1, 1);
        call(OLD, vec![]);
        let _ = m.ft_on_transfer(acc("alice.testnet"), U128(5), "keep".into());
    }

    #[test]
    fn delivered_tokens_count_and_failed_ones_return() {
        let mut m = migrator(2, 1);
        call(OLD, vec![]);
        assert!(matches!(m.ft_on_transfer(acc("alice.testnet"), U128(5), String::new()), PromiseOrValue::Promise(_)));

        call("migrator.ark.protean.testnet", vec![PromiseResult::Successful(vec![])]);
        assert_eq!(m.on_delivered(acc("alice.testnet"), U128(5), U128(10), false).0, 0);
        call("migrator.ark.protean.testnet", vec![PromiseResult::Failed]);
        assert_eq!(m.on_delivered(acc("bob.testnet"), U128(5), U128(10), false).0, 5, "not registered: returned");

        // Staking: the vault used all of it, or none.
        let used = |n: u128| vec![PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(n)).unwrap())];
        call("migrator.ark.protean.testnet", used(10));
        assert_eq!(m.on_delivered(acc("carol.testnet"), U128(5), U128(10), true).0, 0);
        call("migrator.ark.protean.testnet", used(0));
        assert_eq!(m.on_delivered(acc("dave.testnet"), U128(5), U128(10), true).0, 5);

        let info = m.get_info();
        assert_eq!((info.migrated.0, info.issued.0), (10, 20));
    }
}
