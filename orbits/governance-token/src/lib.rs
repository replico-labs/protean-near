//! A fixed-supply NEP-141 token for an Orbits DAO: the whole supply is
//! minted to `owner_id` at creation and nothing can mint more. Built on
//! near-contract-standards, with NEP-145 storage and NEP-148 metadata.

use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, near, require};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, name: String, symbol: String, decimals: u8) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();
        require!(total_supply.0 > 0, "ERR_ZERO_SUPPLY");
        let mut token = FungibleToken::new(StorageKey::Accounts);
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &owner_id,
            amount: total_supply,
            memo: Some("initial supply"),
        }
        .emit();
        Self { token, metadata }
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            near_contract_standards::fungible_token::events::FtBurn {
                owner_id: &sender_id,
                amount: U128(burned),
                memo: Some("receiver closed its account"),
            }
            .emit();
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{env, testing_env};

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn as_caller(who: &str, deposit: NearToken) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acc("token.testnet")).predecessor_account_id(acc(who)).attached_deposit(deposit);
        testing_env!(ctx.build());
    }

    #[test]
    fn whole_supply_goes_to_owner() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        let token = Contract::new(acc("owner.testnet"), U128(1_000), "Ark".into(), "ARK".into(), 18);
        assert_eq!(token.ft_balance_of(acc("owner.testnet")).0, 1_000);
        assert_eq!(token.ft_total_supply().0, 1_000);
        assert_eq!(token.ft_metadata().symbol, "ARK");
    }

    #[test]
    fn registered_accounts_can_receive() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        let mut token = Contract::new(acc("owner.testnet"), U128(1_000), "Ark".into(), "ARK".into(), 18);
        let min = token.storage_balance_bounds().min;
        as_caller("maya.testnet", min);
        token.storage_deposit(None, Some(true));
        as_caller("owner.testnet", NearToken::from_yoctonear(1));
        token.ft_transfer(acc("maya.testnet"), U128(250), None);
        assert_eq!(token.ft_balance_of(acc("maya.testnet")).0, 250);
        assert_eq!(token.ft_balance_of(acc("owner.testnet")).0, 750);
        assert!(env::storage_usage() > 0);
    }

    #[test]
    #[should_panic(expected = "ERR_ZERO_SUPPLY")]
    fn zero_supply_is_refused() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        Contract::new(acc("owner.testnet"), U128(0), "Ark".into(), "ARK".into(), 18);
    }
}
