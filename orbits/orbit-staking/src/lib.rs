//! A DAO's staking contract, shared by whichever orbit governs the DAO.
//!
//! Members stake the DAO's token here (`ft_transfer_call` with an empty
//! message) and take it back with `unstake`. Every change is recorded as a
//! checkpoint, so an orbit asks "what did this account have staked at the
//! proposal's snapshot?" with `weights_at`. Weight fixed at a snapshot can't
//! be moved and used again, so stake can be withdrawn at any time, as with
//! Spaces' snapshot voting.
//!
//! The contract belongs to the DAO (its Sputnik core), not to an orbit, so
//! members keep their stake when the DAO switches models. The orbit that
//! governs the DAO can become the *locker* (`claim_locker`) and lock stake,
//! which conviction voting needs. Locks are kept per locker: an orbit that
//! is replaced can still release what it locked.
//!
//! Storage: each member pays for their own checkpoints from a NEAR balance
//! they deposit with `storage_deposit`.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, assert_one_yocto, env, log,
    near, require,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_GET_POLICY: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// The least a member must deposit to register: their account record and a
/// few dozen checkpoints.
const MIN_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);
const MAX_RESULT_LEN: usize = 64 * 1024;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Members,
    Checkpoints,
    TotalCheckpoints,
    Locks,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Checkpoint {
    /// Block timestamp (ns) from which `amount` applies.
    pub timestamp: U64,
    pub amount: U128,
}

#[near(serializers = [borsh])]
pub struct Member {
    stake: u128,
    /// Sum of every locker's locks on this member.
    locked: u128,
    checkpoints: u32,
    /// NEAR deposited for storage, and what's left of it.
    storage_balance: NearToken,
}

#[near(serializers = [json])]
pub struct MemberView {
    pub stake: U128,
    pub locked: U128,
    pub available: U128,
    pub storage_balance: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao_id: AccountId,
    token_id: AccountId,
    locker: Option<AccountId>,
    members: LookupMap<AccountId, Member>,
    checkpoints: LookupMap<(AccountId, u32), Checkpoint>,
    total_checkpoints: Vector<Checkpoint>,
    total: u128,
    locks: LookupMap<(AccountId, AccountId), u128>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(dao_id: AccountId, token_id: AccountId) -> Self {
        Self {
            dao_id,
            token_id,
            locker: None,
            members: LookupMap::new(StorageKey::Members),
            checkpoints: LookupMap::new(StorageKey::Checkpoints),
            total_checkpoints: Vector::new(StorageKey::TotalCheckpoints),
            total: 0,
            locks: LookupMap::new(StorageKey::Locks),
        }
    }

    // --- Storage ---

    /// Adds NEAR to `account_id`'s storage balance (the caller's by
    /// default), registering them with at least MIN_STORAGE_DEPOSIT.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> NearToken {
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit();
        let member = match self.members.get_mut(&account_id) {
            Some(member) => member,
            None => {
                require!(deposit >= MIN_STORAGE_DEPOSIT, "ERR_DEPOSIT_LESS_THAN_MIN_STORAGE");
                self.members.insert(
                    account_id.clone(),
                    Member { stake: 0, locked: 0, checkpoints: 0, storage_balance: NearToken::from_yoctonear(0) },
                );
                self.members.get_mut(&account_id).unwrap()
            }
        };
        member.storage_balance = member.storage_balance.saturating_add(deposit);
        member.storage_balance
    }

    pub fn storage_balance_bounds(&self) -> NearToken {
        MIN_STORAGE_DEPOSIT
    }

    // --- Staking ---

    /// NEP-141 receiver: the DAO's token sent with an empty message is
    /// staked for the sender. Anything else is refused and returned.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token_id, "ERR_WRONG_TOKEN");
        require!(msg.is_empty(), "ERR_INVALID_MESSAGE");
        require!(self.members.contains_key(&sender_id), "ERR_NOT_REGISTERED: call storage_deposit first");
        self.change_stake(&sender_id, amount.0, true);
        PromiseOrValue::Value(U128(0))
    }

    /// Returns `amount` of the caller's unlocked stake to them. Attach 1 yoctoNEAR.
    #[payable]
    pub fn unstake(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let member = self.members.get(&account_id).expect("ERR_NOT_REGISTERED");
        require!(amount.0 > 0 && member.stake - member.locked >= amount.0, "ERR_NOT_ENOUGH_UNLOCKED_STAKE");
        self.change_stake(&account_id, amount.0, false);
        Promise::new(self.token_id.clone())
            .function_call(
                "ft_transfer",
                serde_json::json!({ "receiver_id": account_id, "amount": amount }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_unstaked(account_id, amount))
    }

    /// Restakes tokens whose transfer back failed.
    #[private]
    pub fn on_unstaked(&mut self, account_id: AccountId, amount: U128) {
        if env::promise_result_checked(0, MAX_RESULT_LEN).is_err() {
            log!("Returning {} to {} failed; restaked", amount.0, account_id);
            self.change_stake(&account_id, amount.0, true);
        }
    }

    // --- Locks ---

    /// Lets the DAO name the locker directly, by a proposal.
    pub fn set_locker(&mut self, locker: Option<AccountId>) {
        require!(env::predecessor_account_id() == self.dao_id, "ERR_NOT_DAO");
        self.locker = locker;
    }

    /// Makes the caller the locker if it is the orbit governing the DAO:
    /// the only member of the core's "governance" role.
    pub fn claim_locker(&mut self) -> Promise {
        Promise::new(self.dao_id.clone())
            .function_call("get_policy", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_GET_POLICY)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_policy(env::predecessor_account_id()),
            )
    }

    #[private]
    pub fn on_policy(&mut self, claimant: AccountId) -> bool {
        let governs = env::promise_result_checked(0, MAX_RESULT_LEN)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|policy| governance_members(&policy))
            .is_some_and(|members| members == [claimant.to_string()]);
        if governs {
            self.locker = Some(claimant);
        } else {
            log!("{} doesn't govern {}; locker unchanged", claimant, self.dao_id);
        }
        governs
    }

    /// Locks all of `account_id`'s unlocked stake for the caller, the
    /// locker. Returns the amount locked.
    pub fn lock_available(&mut self, account_id: AccountId) -> U128 {
        let locker = env::predecessor_account_id();
        require!(self.locker.as_ref() == Some(&locker), "ERR_NOT_LOCKER");
        let member = self.members.get_mut(&account_id).expect("ERR_NOT_REGISTERED");
        let amount = member.stake - member.locked;
        member.locked += amount;
        *self.locks.entry((locker, account_id)).or_insert(0) += amount;
        U128(amount)
    }

    /// Releases `amount` the caller locked on `account_id`. Any past locker
    /// may release its own locks.
    pub fn unlock(&mut self, account_id: AccountId, amount: U128) {
        let key = (env::predecessor_account_id(), account_id.clone());
        let locked = self.locks.get(&key).copied().unwrap_or(0);
        require!(locked >= amount.0, "ERR_NOT_LOCKED");
        if locked == amount.0 {
            self.locks.remove(&key);
        } else {
            self.locks.insert(key, locked - amount.0);
        }
        self.members.get_mut(&account_id).expect("ERR_NOT_REGISTERED").locked -= amount.0;
    }

    // --- Views ---

    pub fn get_dao(&self) -> AccountId {
        self.dao_id.clone()
    }

    pub fn get_token(&self) -> AccountId {
        self.token_id.clone()
    }

    pub fn get_locker(&self) -> Option<AccountId> {
        self.locker.clone()
    }

    pub fn get_member(&self, account_id: AccountId) -> Option<MemberView> {
        self.members.get(&account_id).map(|m| MemberView {
            stake: U128(m.stake),
            locked: U128(m.locked),
            available: U128(m.stake - m.locked),
            storage_balance: m.storage_balance,
        })
    }

    pub fn total_staked(&self) -> U128 {
        U128(self.total)
    }

    /// What `locker` has locked on `account_id`.
    pub fn locked_by(&self, locker: AccountId, account_id: AccountId) -> U128 {
        U128(self.locks.get(&(locker, account_id)).copied().unwrap_or(0))
    }

    /// `account_id`'s stake and the total stake strictly before `timestamp`
    /// (ns): what a snapshot taken at `timestamp` counts.
    pub fn weights_at(&self, account_id: AccountId, timestamp: U64) -> (U128, U128) {
        let count = self.members.get(&account_id).map_or(0, |m| m.checkpoints);
        let own = find_before(count, timestamp.0, |i| self.checkpoints[&(account_id.clone(), i)]);
        let total = find_before(self.total_checkpoints.len(), timestamp.0, |i| self.total_checkpoints[i]);
        (U128(own), U128(total))
    }
}

impl Contract {
    /// Adds or removes stake and records the new amounts. The member's
    /// storage balance pays for the storage this uses.
    fn change_stake(&mut self, account_id: &AccountId, amount: u128, add: bool) {
        let storage_before = env::storage_usage();
        let now = env::block_timestamp();
        let member = self.members.get_mut(account_id).expect("ERR_NOT_REGISTERED");
        member.stake = if add { member.stake + amount } else { member.stake - amount };
        let point = Checkpoint { timestamp: U64(now), amount: U128(member.stake) };
        let index = member.checkpoints;
        let last = index.checked_sub(1).map(|i| (account_id.clone(), i));
        match last {
            // Several changes in one block keep one checkpoint.
            Some(key) if self.checkpoints[&key].timestamp.0 == now => {
                self.checkpoints.insert(key, point);
            }
            _ => {
                self.checkpoints.insert((account_id.clone(), index), point);
                self.members.get_mut(account_id).unwrap().checkpoints += 1;
            }
        }
        self.total = if add { self.total + amount } else { self.total - amount };
        let total_point = Checkpoint { timestamp: U64(now), amount: U128(self.total) };
        match self.total_checkpoints.len().checked_sub(1) {
            Some(i) if self.total_checkpoints[i].timestamp.0 == now => self.total_checkpoints[i] = total_point,
            _ => self.total_checkpoints.push(total_point),
        }

        self.members.flush();
        self.checkpoints.flush();
        self.total_checkpoints.flush();
        let used = env::storage_usage().saturating_sub(storage_before);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
        let member = self.members.get_mut(account_id).unwrap();
        require!(member.storage_balance >= cost, "ERR_STORAGE: add NEAR with storage_deposit");
        member.storage_balance = member.storage_balance.saturating_sub(cost);
    }
}

/// The amount of the last checkpoint strictly before `timestamp`, by binary search.
fn find_before(count: u32, timestamp: u64, at: impl Fn(u32) -> Checkpoint) -> u128 {
    let (mut low, mut high) = (0u32, count);
    while low < high {
        let mid = low + (high - low) / 2;
        if at(mid).timestamp.0 < timestamp {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    if low == 0 { 0 } else { at(low - 1).amount.0 }
}

/// Members of the "governance" role in a Sputnik policy, as JSON.
fn governance_members(policy: &Value) -> Option<Vec<String>> {
    let role = policy.get("roles")?.as_array()?.iter().find(|r| r.get("name").and_then(Value::as_str) == Some("governance"))?;
    role.get("kind")?.get("Group")?.as_array()?.iter().map(|m| m.as_str().map(str::to_owned)).collect()
}

#[cfg(test)]
mod tests;
