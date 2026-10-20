//! Token-weight orbit: staked tokens vote, with delegation.
//!
//! The orbit is the only member of its Sputnik core (see docs/SPEC.md).
//! People propose and vote here; when a vote passes, the orbit adds the
//! proposal to the core and approves it with its single vote, and Sputnik
//! executes it.
//!
//! Voting weight comes from Sputnik's own staking contract, deployed with
//! this orbit as its owner. The staking contract reports every delegation
//! to its owner through `register_delegation`, `delegate` and `undelegate`,
//! the same hooks the Sputnik DAO implements (sputnikdao2/src/delegation.rs).
//! Undelegated tokens stay locked for the staking contract's unstake period,
//! which must be longer than `voting_period` so a stake can't vote twice.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    env, log, near, require,
};
use orbit_common::{KindClass, act_proposal_args, add_proposal_args, parse_kind};

/// Gas for the core's `add_proposal` and for reading the new orbit's `get_dao`.
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_GET_DAO: Gas = Gas::from_tgas(5);
/// Minimum gas for `act_proposal`; it gets whatever is left on top, since
/// executing the proposal (a function call, say) may need much more.
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(30);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// Gas a call must still have for the orbit to start sending a passed
/// proposal. Below it, `vote` only records the pass and `execute` sends it.
const GAS_TO_SEND: Gas = Gas::from_tgas(150);

/// A send that hasn't finished after this long is assumed lost and may be
/// retried. A NEAR call chain settles within seconds.
const SEND_TIMEOUT_NS: u64 = 10 * 60 * 1_000_000_000;

const MAX_DESCRIPTION_LEN: usize = 4_096;
const MAX_KIND_LEN: usize = 16_384;
const MAX_RESULT_LEN: usize = 256;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Delegations,
    Proposals,
    Votes,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Share of all delegated weight needed to pass or reject, as
    /// [numerator, denominator]. Like Sputnik, [1, 2] means more than half.
    pub threshold: (u64, u64),
    /// Minimum weight needed to pass or reject, whatever the share.
    pub quorum: U128,
    /// How long a proposal can be voted on, in nanoseconds.
    pub voting_period: U64,
    /// Weight an account needs to make a proposal. 0 lets anyone propose.
    pub min_proposer_weight: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Choice {
    Approve,
    Reject,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    InProgress,
    /// Passed here; not yet executed on the core.
    Passed,
    /// Approved on the core, which executed it.
    Executed,
    Rejected,
    Expired,
}

#[near(serializers = [borsh])]
pub struct Proposal {
    proposer: AccountId,
    description: String,
    /// A Sputnik `ProposalKind`, as JSON.
    kind: String,
    submission_time: u64,
    approve: u128,
    reject: u128,
    voters: u32,
    status: Status,
    /// The proposal's id on the core, once added there.
    core_id: Option<u64>,
    /// When the current send to the core started, if one is under way.
    sending_since: Option<u64>,
}

#[near(serializers = [json])]
pub struct ProposalView {
    pub id: u64,
    pub proposer: AccountId,
    pub description: String,
    pub kind: Value,
    pub status: Status,
    pub approve: U128,
    pub reject: U128,
    pub voters: u32,
    pub submission_time: U64,
    pub voting_ends: U64,
    pub core_proposal_id: Option<u64>,
    pub sending: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao_id: AccountId,
    staking_id: AccountId,
    /// The staking contract's token. Recorded for clients; the staking
    /// contract is what enforces it.
    token_id: AccountId,
    config: Config,
    delegations: LookupMap<AccountId, u128>,
    total_delegation: u128,
    proposals: LookupMap<u64, Proposal>,
    votes: LookupMap<(u64, AccountId), Choice>,
    /// Number of proposals made; the next proposal's id.
    proposal_count: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(dao_id: AccountId, staking_id: AccountId, token_id: AccountId, config: Config) -> Self {
        let (num, denom) = config.threshold;
        require!(denom > 0 && num <= denom, "ERR_THRESHOLD");
        require!(config.voting_period.0 > 0, "ERR_VOTING_PERIOD");
        Self {
            dao_id,
            staking_id,
            token_id,
            config,
            delegations: LookupMap::new(StorageKey::Delegations),
            total_delegation: 0,
            proposals: LookupMap::new(StorageKey::Proposals),
            votes: LookupMap::new(StorageKey::Votes),
            proposal_count: 0,
        }
    }

    // --- Delegation hooks, called by the staking contract only ---

    /// Called by the staking contract when a user registers there, with
    /// enough NEAR attached to store their delegation total.
    #[payable]
    pub fn register_delegation(&mut self, account_id: AccountId) {
        self.assert_staking();
        require!(
            env::attached_deposit() == env::storage_byte_cost().saturating_mul(16),
            "ERR_DEPOSIT"
        );
        self.delegations.entry(account_id).or_insert(0);
    }

    /// Adds `amount` to `account_id`'s voting weight. Returns the previous
    /// and new weight and the total, as Sputnik does.
    pub fn delegate(&mut self, account_id: AccountId, amount: U128) -> (U128, U128, U128) {
        self.assert_staking();
        let weight = self.delegations.get_mut(&account_id).expect("ERR_NOT_REGISTERED");
        let prev = *weight;
        *weight += amount.0;
        let new = *weight;
        self.total_delegation += amount.0;
        (U128(prev), U128(new), U128(self.total_delegation))
    }

    /// Removes `amount` from `account_id`'s voting weight.
    pub fn undelegate(&mut self, account_id: AccountId, amount: U128) -> (U128, U128, U128) {
        self.assert_staking();
        let weight = self.delegations.get_mut(&account_id).expect("ERR_NOT_REGISTERED");
        require!(*weight >= amount.0, "ERR_INVALID_STAKING_CONTRACT");
        let prev = *weight;
        *weight -= amount.0;
        let new = *weight;
        self.total_delegation -= amount.0;
        (U128(prev), U128(new), U128(self.total_delegation))
    }

    // --- Proposals ---

    /// Proposes `kind`, a Sputnik `ProposalKind` as JSON (for example
    /// `{"Transfer":{...}}`). The proposer pays for the proposal's storage;
    /// anything attached beyond that is refunded. Returns the proposal id.
    #[payable]
    pub fn propose(&mut self, description: String, kind: String) -> u64 {
        let proposer = env::predecessor_account_id();
        require!(description.len() <= MAX_DESCRIPTION_LEN, "ERR_DESCRIPTION_TOO_LONG");
        require!(kind.len() <= MAX_KIND_LEN, "ERR_KIND_TOO_LONG");
        if let Err(err) = parse_kind(&kind) {
            env::panic_str(err);
        }
        let min = self.config.min_proposer_weight.0;
        require!(min == 0 || self.weight_of(&proposer) >= min, "ERR_NOT_ENOUGH_WEIGHT_TO_PROPOSE");

        let storage_before = env::storage_usage();
        let id = self.proposal_count;
        self.proposals.insert(
            id,
            Proposal {
                proposer: proposer.clone(),
                description,
                kind,
                submission_time: env::block_timestamp(),
                approve: 0,
                reject: 0,
                voters: 0,
                status: Status::InProgress,
                core_id: None,
                sending_since: None,
            },
        );
        self.proposal_count += 1;
        self.proposals.flush();
        let cost = env::storage_byte_cost()
            .saturating_mul((env::storage_usage() - storage_before) as u128);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("ERR_DEPOSIT: attach at least {} yoctoNEAR", cost.as_yoctonear()));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(proposer).transfer(refund).detach();
        }
        id
    }

    /// Votes on proposal `id` with the caller's current weight. If the vote
    /// passes it, and enough gas is attached, the orbit sends it to the core
    /// at once; otherwise call `execute`. Returns the proposal's new status.
    pub fn vote(&mut self, id: u64, choice: Choice) -> Status {
        let voter = env::predecessor_account_id();
        let threshold = self.threshold();
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        require!(proposal.status == Status::InProgress, "ERR_PROPOSAL_NOT_IN_PROGRESS");
        if env::block_timestamp() > proposal.submission_time + self.config.voting_period.0 {
            proposal.status = Status::Expired;
            return Status::Expired;
        }
        let weight = self.delegations.get(&voter).copied().unwrap_or(0);
        require!(weight > 0, "ERR_NO_WEIGHT");
        require!(self.votes.insert((id, voter), choice).is_none(), "ERR_ALREADY_VOTED");

        match choice {
            Choice::Approve => proposal.approve += weight,
            Choice::Reject => proposal.reject += weight,
        }
        proposal.voters += 1;
        if proposal.approve >= threshold {
            proposal.status = Status::Passed;
        } else if proposal.reject >= threshold {
            proposal.status = Status::Rejected;
        }
        let status = proposal.status;
        if status == Status::Passed && env::prepaid_gas().saturating_sub(env::used_gas()) >= GAS_TO_SEND {
            self.start_send(id).detach();
        }
        status
    }

    /// Sends passed proposal `id` to the core and approves it there. Anyone
    /// may call it; attach about 300 Tgas.
    pub fn execute(&mut self, id: u64) -> Promise {
        require!(
            env::prepaid_gas().saturating_sub(env::used_gas()) >= GAS_TO_SEND,
            "ERR_NOT_ENOUGH_GAS: attach 300 Tgas"
        );
        self.start_send(id)
    }

    /// Marks proposal `id` expired once its voting period is over.
    pub fn finalize(&mut self, id: u64) -> Status {
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        require!(proposal.status == Status::InProgress, "ERR_PROPOSAL_NOT_IN_PROGRESS");
        require!(
            env::block_timestamp() > proposal.submission_time + self.config.voting_period.0,
            "ERR_VOTING_NOT_OVER"
        );
        proposal.status = Status::Expired;
        Status::Expired
    }

    // --- Sending to the core ---

    #[private]
    pub fn on_swap_checked(&mut self, id: u64) -> PromiseOrValue<()> {
        let bound_to: Option<AccountId> = callback_value();
        if bound_to.as_ref() == Some(&self.dao_id) {
            return PromiseOrValue::Promise(self.add_to_core(id));
        }
        log!("Swap target is not an orbit bound to {}; proposal {} not sent", self.dao_id, id);
        self.end_send(id);
        PromiseOrValue::Value(())
    }

    #[private]
    pub fn on_added(&mut self, id: u64) -> PromiseOrValue<()> {
        match callback_value::<u64>() {
            Some(core_id) => {
                self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL").core_id = Some(core_id);
                PromiseOrValue::Promise(self.approve_on_core(id))
            }
            None => {
                log!("Core refused proposal {}", id);
                self.end_send(id);
                PromiseOrValue::Value(())
            }
        }
    }

    #[private]
    pub fn on_approved(&mut self, id: u64) {
        let ok = env::promise_result_checked(0, MAX_RESULT_LEN).is_ok();
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        proposal.sending_since = None;
        if ok {
            proposal.status = Status::Executed;
        } else {
            log!("Core approval of proposal {} failed; call execute to retry", id);
        }
    }

    // --- Views ---

    pub fn get_dao(&self) -> AccountId {
        self.dao_id.clone()
    }

    pub fn get_staking_contract(&self) -> AccountId {
        self.staking_id.clone()
    }

    pub fn get_token(&self) -> AccountId {
        self.token_id.clone()
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn delegation_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.weight_of(&account_id))
    }

    pub fn delegation_total_supply(&self) -> U128 {
        U128(self.total_delegation)
    }

    /// Weight a proposal currently needs to pass or be rejected.
    pub fn get_threshold(&self) -> U128 {
        U128(self.threshold())
    }

    /// Number of proposals made; ids run from 0 to this minus one.
    pub fn get_proposal_count(&self) -> u64 {
        self.proposal_count
    }

    pub fn get_proposal(&self, id: u64) -> Option<ProposalView> {
        self.proposals.get(&id).map(|p| self.view(id, p))
    }

    pub fn get_proposals(&self, from_index: u64, limit: u64) -> Vec<ProposalView> {
        (from_index..self.proposal_count.min(from_index.saturating_add(limit)))
            .filter_map(|id| self.get_proposal(id))
            .collect()
    }

    pub fn get_vote(&self, id: u64, account_id: AccountId) -> Option<Choice> {
        self.votes.get(&(id, account_id)).copied()
    }
}

impl Contract {
    fn assert_staking(&self) {
        require!(env::predecessor_account_id() == self.staking_id, "ERR_INVALID_CALLER");
    }

    fn weight_of(&self, account_id: &AccountId) -> u128 {
        self.delegations.get(account_id).copied().unwrap_or(0)
    }

    /// Sputnik's token-weight threshold (policy.rs): the larger of the quorum
    /// and the share of all delegated weight, and never less than 1.
    fn threshold(&self) -> u128 {
        let (num, denom) = self.config.threshold;
        let total = self.total_delegation;
        let (num, denom) = (u128::from(num), u128::from(denom));
        // num * total / denom, split so it can't overflow for any total.
        let share = total / denom * num + total % denom * num / denom;
        let share = (share + 1).min(total);
        share.max(self.config.quorum.0).max(1)
    }

    fn view(&self, id: u64, p: &Proposal) -> ProposalView {
        ProposalView {
            id,
            proposer: p.proposer.clone(),
            description: p.description.clone(),
            kind: serde_json::from_str(&p.kind).unwrap_or(Value::Null),
            status: p.status,
            approve: U128(p.approve),
            reject: U128(p.reject),
            voters: p.voters,
            submission_time: U64(p.submission_time),
            voting_ends: U64(p.submission_time + self.config.voting_period.0),
            core_proposal_id: p.core_id,
            sending: p.sending_since.is_some(),
        }
    }

    /// Starts sending passed proposal `id` to the core. Only one send runs at
    /// a time, so the core can't get the same proposal twice.
    fn start_send(&mut self, id: u64) -> Promise {
        let now = env::block_timestamp();
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        require!(proposal.status == Status::Passed, "ERR_PROPOSAL_NOT_PASSED");
        if let Some(since) = proposal.sending_since {
            require!(now > since + SEND_TIMEOUT_NS, "ERR_ALREADY_SENDING");
        }
        proposal.sending_since = Some(now);
        if proposal.core_id.is_some() {
            return self.approve_on_core(id);
        }
        match parse_kind(&proposal.kind) {
            Ok((_, KindClass::Swap { new_orbit })) => Promise::new(new_orbit)
                .function_call("get_dao", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_GET_DAO)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .with_unused_gas_weight(1)
                        .on_swap_checked(id),
                ),
            Ok((_, KindClass::Normal)) => self.add_to_core(id),
            Err(err) => env::panic_str(err),
        }
    }

    fn add_to_core(&self, id: u64) -> Promise {
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        let kind: Value = serde_json::from_str(&proposal.kind).expect("ERR_KIND_NOT_JSON");
        Promise::new(self.dao_id.clone())
            .function_call(
                "add_proposal",
                add_proposal_args(&proposal.description, &kind),
                NearToken::from_yoctonear(0),
                GAS_ADD_PROPOSAL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK.saturating_add(GAS_ACT_PROPOSAL))
                    .with_unused_gas_weight(1)
                    .on_added(id),
            )
    }

    fn approve_on_core(&self, id: u64) -> Promise {
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        let core_id = proposal.core_id.expect("ERR_NOT_ON_CORE");
        let kind: Value = serde_json::from_str(&proposal.kind).expect("ERR_KIND_NOT_JSON");
        Promise::new(self.dao_id.clone())
            .function_call_weight(
                "act_proposal",
                act_proposal_args(core_id, &kind),
                NearToken::from_yoctonear(0),
                GAS_ACT_PROPOSAL,
                GasWeight(1),
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_approved(id))
    }

    fn end_send(&mut self, id: u64) {
        self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL").sending_since = None;
    }
}

/// The JSON value the previous call returned, or `None` if it failed or
/// returned something else. Never panics, so a callback always records the
/// outcome.
fn callback_value<T: near_sdk::serde::de::DeserializeOwned>() -> Option<T> {
    let bytes = env::promise_result_checked(0, MAX_RESULT_LEN).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests;
