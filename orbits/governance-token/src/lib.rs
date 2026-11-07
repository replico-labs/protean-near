//! The NEP-141 token of an Orbits DAO, with a cap on everything it will ever
//! issue. Built on near-contract-standards, with NEP-145 storage and NEP-148
//! metadata.
//!
//! - `total_supply` is minted to `owner_id` at creation.
//! - `max_supply` (default: the initial supply, a fixed-supply token) caps
//!   every token ever minted, counted in `total_minted`. Burning lowers the
//!   supply in circulation but never `total_minted`, so a burned token can't
//!   be issued again.
//! - Only `minter`, the DAO's Sputnik core, mints: a passed proposal. With
//!   no minter, nothing more can be minted.
//! - Anyone burns their own tokens.

use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, assert_one_yocto, env, near, require};

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
    minter: Option<AccountId>,
    max_supply: u128,
    total_minted: u128,
}

/// What the token can still issue, for anyone to check.
#[near(serializers = [json])]
pub struct SupplyView {
    pub total_supply: U128,
    pub total_minted: U128,
    pub max_supply: U128,
    pub mintable: U128,
    pub minter: Option<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        total_supply: U128,
        name: String,
        symbol: String,
        decimals: u8,
        max_supply: Option<U128>,
        minter: Option<AccountId>,
    ) -> Self {
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
        let max_supply = max_supply.map_or(total_supply.0, |m| m.0);
        require!(max_supply >= total_supply.0, "ERR_CAP_BELOW_SUPPLY");
        let mut token = FungibleToken::new(StorageKey::Accounts);
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &owner_id,
            amount: total_supply,
            memo: Some("initial supply"),
        }
        .emit();
        Self { token, metadata, minter, max_supply, total_minted: total_supply.0 }
    }

    /// Mints `amount` to `account_id`, registering it if needed. Only the
    /// minter, and never past the cap on everything ever minted.
    #[payable]
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        assert_one_yocto();
        require!(self.minter.as_ref() == Some(&env::predecessor_account_id()), "ERR_NOT_MINTER");
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let minted = self.total_minted.checked_add(amount.0).filter(|m| *m <= self.max_supply);
        self.total_minted = minted.unwrap_or_else(|| env::panic_str("ERR_CAP_EXCEEDED"));
        if !self.token.accounts.contains_key(&account_id) {
            // Paid from the token's own balance: only the DAO mints.
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        near_contract_standards::fungible_token::events::FtMint { owner_id: &account_id, amount, memo: None }.emit();
    }

    /// Burns `amount` of the caller's tokens. They never count as mintable again.
    #[payable]
    pub fn burn(&mut self, amount: U128) {
        assert_one_yocto();
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let owner = env::predecessor_account_id();
        self.token.internal_withdraw(&owner, amount.0);
        near_contract_standards::fungible_token::events::FtBurn { owner_id: &owner, amount, memo: None }.emit();
    }

    pub fn get_supply(&self) -> SupplyView {
        SupplyView {
            total_supply: self.token.ft_total_supply(),
            total_minted: U128(self.total_minted),
            max_supply: U128(self.max_supply),
            mintable: U128(if self.minter.is_some() { self.max_supply - self.total_minted } else { 0 }),
            minter: self.minter.clone(),
        }
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

    fn fixed() -> Contract {
        Contract::new(acc("owner.testnet"), U128(1_000), "Ark".into(), "ARK".into(), 18, None, None)
    }

    fn capped() -> Contract {
        Contract::new(acc("owner.testnet"), U128(1_000), "Ark".into(), "ARK".into(), 18, Some(U128(1_500)), Some(acc("dao.testnet")))
    }

    #[test]
    fn whole_supply_goes_to_owner() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        let token = fixed();
        assert_eq!(token.ft_balance_of(acc("owner.testnet")).0, 1_000);
        assert_eq!(token.ft_total_supply().0, 1_000);
        assert_eq!(token.ft_metadata().symbol, "ARK");
    }

    #[test]
    fn registered_accounts_can_receive() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        let mut token = fixed();
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
        Contract::new(acc("owner.testnet"), U128(0), "Ark".into(), "ARK".into(), 18, None, None);
    }

    #[test]
    fn a_fixed_token_never_mints() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        let token = fixed();
        let supply = token.get_supply();
        assert_eq!((supply.max_supply.0, supply.mintable.0, supply.minter), (1_000, 0, None));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_MINTER")]
    fn only_the_minter_mints() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        let mut token = fixed();
        as_caller("owner.testnet", NearToken::from_yoctonear(1));
        token.mint(acc("owner.testnet"), U128(1));
    }

    #[test]
    fn the_dao_mints_up_to_the_cap_and_registers_the_receiver() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        let mut token = capped();
        as_caller("dao.testnet", NearToken::from_yoctonear(1));
        token.mint(acc("grantee.testnet"), U128(400));
        assert_eq!(token.ft_balance_of(acc("grantee.testnet")).0, 400);
        let supply = token.get_supply();
        assert_eq!((supply.total_supply.0, supply.total_minted.0, supply.mintable.0), (1_400, 1_400, 100));
    }

    #[test]
    #[should_panic(expected = "ERR_CAP_EXCEEDED")]
    fn burned_tokens_never_free_room_under_the_cap() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        let mut token = capped();
        as_caller("owner.testnet", NearToken::from_yoctonear(1));
        token.burn(U128(600));
        assert_eq!(token.ft_total_supply().0, 400);
        assert_eq!(token.get_supply().mintable.0, 500, "the burn freed nothing");
        as_caller("dao.testnet", NearToken::from_yoctonear(1));
        token.mint(acc("owner.testnet"), U128(501));
    }

    #[test]
    #[should_panic(expected = "ERR_CAP_BELOW_SUPPLY")]
    fn the_cap_covers_the_initial_supply() {
        as_caller("deployer.testnet", NearToken::from_near(0));
        Contract::new(acc("owner.testnet"), U128(1_000), "Ark".into(), "ARK".into(), 18, Some(U128(999)), None);
    }
}
