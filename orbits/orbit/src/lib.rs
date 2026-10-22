//! An orbit: the governance module of an Orbits DAO.
//!
//! The orbit is the only member of its Sputnik core (see docs/SPEC.md).
//! People propose and decide here, under the orbit's model; when a proposal
//! passes and its timelock is over, `execute` adds it to the core and
//! approves it with the orbit's single vote, and Sputnik executes it.
//!
//! This crate is the engine every Orbits module is built from. Each model
//! (model.rs) is a Cargo feature, and each module under orbits/modules is
//! its own contract that enables one feature, so it carries only its own
//! model's methods. The logic that matters most, sending a passed proposal
//! to the core exactly once and only swapping to an orbit bound to the same
//! core, is written once here and shared by all of them. Stake comes from
//! the DAO's staking contract (orbits/orbit-staking), read by snapshot.
//!
//! Files: ballot.rs (token-weighted, quadratic, liquid and optimistic
//! votes), conviction.rs, council.rs (delegate and sortition),
//! sowellian.rs and markets.rs (decision markets).

// A module built with one model leaves the other models' helpers unused.
#![cfg_attr(
    not(all(
        feature = "token-weighted",
        feature = "quadratic",
        feature = "liquid",
        feature = "optimistic",
        feature = "conviction",
        feature = "delegate",
        feature = "sortition",
        feature = "sowellian",
        feature = "decision-markets"
    )),
    allow(dead_code, unused_imports, unused_variables)
)]

mod ballot;
mod conviction;
mod council;
mod markets;
mod model;
mod sowellian;

pub use model::*;

use near_sdk::json_types::{U64, U128};
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, log, near,
    require,
};
use orbit_common::{KindClass, act_proposal_args, add_proposal_args, parse_kind};

pub(crate) const GAS_VIEW: Gas = Gas::from_tgas(10);
pub(crate) const GAS_CALLBACK: Gas = Gas::from_tgas(15);
pub(crate) const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(30);
/// Gas `execute` needs to send a proposal to the core and approve it there.
const GAS_TO_SEND: Gas = Gas::from_tgas(150);
/// A send that hasn't finished after this long is assumed lost and may be
/// retried. A NEAR call chain settles within seconds.
const SEND_TIMEOUT_NS: u64 = 10 * 60 * 1_000_000_000;
const MAX_DESCRIPTION_LEN: usize = 4_096;
const MAX_KIND_LEN: usize = 16_384;
pub(crate) const MAX_RESULT_LEN: usize = 4_096;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Proposals,
    Receipts,
    Delegations,
    Supports,
    Elections,
    Candidates,
    ElectionVotes,
    ElectionVoters,
    Recalls,
    RecallVoters,
    Pool,
    PoolMembers,
    Positions,
    AdjudicationVoters,
    Holdings,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Choice {
    For,
    Against,
    Abstain,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum State {
    /// Voting hasn't started, or the proposer's stake is being checked.
    Pending,
    Active,
    /// Optimistic: it will pass unless someone challenges it first.
    ChallengeWindow,
    /// Passed; executable once its timelock is over.
    Succeeded,
    Defeated,
    /// Conviction: reached its conviction and was queued.
    Queued,
    /// Sowellian: approved; YES/NO positions may be taken.
    Positions,
    /// Approved on the core, which executed it.
    Executed,
    /// Passed, but wasn't executed within its execution period.
    Expired,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub choice: Choice,
    pub weight: U128,
    /// The weight is still being read from the staking contract.
    pub pending: bool,
    /// Liquid: the delegate whose vote this one followed.
    pub via: Option<AccountId>,
}

#[near(serializers = [borsh])]
pub struct Proposal {
    proposer: AccountId,
    description: String,
    /// A Sputnik `ProposalKind`, as JSON.
    kind: String,
    /// Snapshot: stake strictly before this time counts.
    created_at: u64,
    start: u64,
    /// End of voting, or of the challenge window (optimistic).
    end: u64,
    activated: bool,
    cancelled: bool,
    executed: bool,
    for_: u128,
    against: u128,
    abstain: u128,
    voters: u32,
    /// Total stake at the snapshot (square-rooted for quadratic), once read.
    total: Option<u128>,
    /// NEAR the proposer paid for storage; refunded if they lack the stake to propose.
    deposit: NearToken,
    core_id: Option<u64>,
    sending_since: Option<u64>,
    challenger: Option<AccountId>,
    bond_resolved: bool,
    conviction: u128,
    conviction_at: u64,
    support: u128,
    required: u128,
    queued_at: Option<u64>,
    /// Sowellian and decision markets keep their market here.
    market: Option<Market>,
}

#[near(serializers = [borsh])]
pub enum Market {
    Sowellian(sowellian::Bet),
    Decision(markets::Exchange),
}

#[near(serializers = [json])]
pub struct ProposalView {
    pub id: u64,
    pub proposer: AccountId,
    pub description: String,
    pub kind: Value,
    pub state: State,
    pub snapshot: U64,
    pub start: U64,
    pub end: U64,
    /// When it may execute, once it has passed or been queued.
    pub executable_after: Option<U64>,
    pub for_votes: U128,
    pub against_votes: U128,
    pub abstain_votes: U128,
    pub voters: u32,
    pub total: Option<U128>,
    pub challenger: Option<AccountId>,
    pub conviction: U128,
    pub support: U128,
    pub required_conviction: U128,
    pub core_proposal_id: Option<u64>,
    pub sending: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao_id: AccountId,
    staking_id: AccountId,
    token_id: AccountId,
    model: Model,
    proposals: LookupMap<u64, Proposal>,
    proposal_count: u64,
    receipts: LookupMap<(u64, AccountId), Receipt>,
    // Liquid
    delegations: LookupMap<AccountId, AccountId>,
    // Conviction: what each member backs, and with how much (0 while pending).
    supports: LookupMap<AccountId, (u64, u128)>,
    // Councils
    council: Vec<AccountId>,
    term_end: u64,
    elections: LookupMap<u64, council::Election>,
    election_count: u64,
    candidates: LookupSet<(u64, AccountId)>,
    election_votes: LookupMap<(u64, AccountId), u128>,
    election_voters: LookupMap<(u64, AccountId), bool>,
    recalls: LookupMap<u64, council::Recall>,
    recall_count: u64,
    recall_voters: LookupMap<(u64, AccountId), bool>,
    pool: Vector<AccountId>,
    pool_members: LookupSet<AccountId>,
    // Sowellian
    positions: LookupMap<(u64, AccountId), sowellian::Position>,
    adjudication_voters: LookupMap<(u64, AccountId), bool>,
    // Decision markets
    holdings: LookupMap<(u64, AccountId), markets::Holdings>,
}

#[near]
impl Contract {
    /// `council` starts the council of a delegate or sortition orbit.
    #[init]
    pub fn new(dao_id: AccountId, staking_id: AccountId, token_id: AccountId, model: Model, council: Option<Vec<AccountId>>) -> Self {
        require!(model.is_built(), format!("ERR_MODEL: this module doesn't run {}", model.name()));
        model.validate();
        let council = council.unwrap_or_default();
        if let Some(size) = match &model {
            Model::Delegate(d) => Some(d.council_size),
            Model::Sortition(s) => Some(s.council_size),
            _ => None,
        } {
            require!(council.len() <= usize::from(size), "ERR_CONFIG: council larger than council_size");
        } else {
            require!(council.is_empty(), "ERR_CONFIG: only council models take a council");
        }
        let term_end = match &model {
            Model::Delegate(d) => env::block_timestamp() + d.term_length.0,
            Model::Sortition(s) => env::block_timestamp() + s.term_length.0,
            _ => 0,
        };
        Self {
            dao_id,
            staking_id,
            token_id,
            model,
            proposals: LookupMap::new(StorageKey::Proposals),
            proposal_count: 0,
            receipts: LookupMap::new(StorageKey::Receipts),
            delegations: LookupMap::new(StorageKey::Delegations),
            supports: LookupMap::new(StorageKey::Supports),
            council,
            term_end,
            elections: LookupMap::new(StorageKey::Elections),
            election_count: 0,
            candidates: LookupSet::new(StorageKey::Candidates),
            election_votes: LookupMap::new(StorageKey::ElectionVotes),
            election_voters: LookupMap::new(StorageKey::ElectionVoters),
            recalls: LookupMap::new(StorageKey::Recalls),
            recall_count: 0,
            recall_voters: LookupMap::new(StorageKey::RecallVoters),
            pool: Vector::new(StorageKey::Pool),
            pool_members: LookupSet::new(StorageKey::PoolMembers),
            positions: LookupMap::new(StorageKey::Positions),
            adjudication_voters: LookupMap::new(StorageKey::AdjudicationVoters),
            holdings: LookupMap::new(StorageKey::Holdings),
        }
    }

    // --- Proposals ---

    /// Proposes `kind`, a Sputnik `ProposalKind` as JSON (for example
    /// `{"Transfer":{...}}`). The proposer pays for its storage; anything
    /// attached beyond that is refunded. In a council model only council
    /// members propose; otherwise, with a proposal threshold, the
    /// proposer's stake is checked first and the proposal is cancelled (and
    /// the deposit refunded) if it's too low. Returns the proposal id.
    #[payable]
    pub fn propose(&mut self, description: String, kind: String) -> PromiseOrValue<u64> {
        require!(!matches!(self.model, Model::Sowellian(_)), "ERR_USE_PROPOSE_WITH_CRITERIA");
        let proposer = env::predecessor_account_id();
        let council_model = self.model.council().is_some();
        if council_model {
            require!(self.council.contains(&proposer), "ERR_NOT_COUNCIL_MEMBER");
        }
        let threshold = self.model.proposal_threshold();
        // Decision markets activate once both seeds are in.
        let activated = (council_model || threshold == 0) && !matches!(self.model, Model::DecisionMarkets(_));
        let market = match &self.model {
            Model::DecisionMarkets(_) => Some(Market::Decision(markets::Exchange::default())),
            _ => None,
        };
        let id = self.create_proposal(&proposer, description, kind, activated, market);
        if activated || threshold == 0 {
            return PromiseOrValue::Value(id);
        }
        let now = env::block_timestamp();
        PromiseOrValue::Promise(self.weights_at(&proposer, now).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_proposer_stake(id),
        ))
    }

    /// Activates proposal `id` if its proposer had the stake to propose;
    /// otherwise cancels it and refunds their deposit.
    #[private]
    pub fn on_proposer_stake(&mut self, id: u64) -> u64 {
        let stake = callback_value::<(U128, U128)>().map(|(own, _)| own.0);
        let threshold = self.model.proposal_threshold();
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        if stake.is_some_and(|s| s >= threshold) {
            proposal.activated = true;
        } else {
            log!("Proposal {} cancelled: the proposer needs {} staked", id, threshold);
            proposal.cancelled = true;
            Promise::new(proposal.proposer.clone()).transfer(proposal.deposit).detach();
        }
        id
    }

    /// The proposer withdraws proposal `id`, any time before it's executed.
    pub fn cancel(&mut self, id: u64) {
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        require!(env::predecessor_account_id() == proposal.proposer, "ERR_NOT_PROPOSER");
        require!(!proposal.executed && !proposal.cancelled, "ERR_PROPOSAL_CLOSED");
        require!(proposal.core_id.is_none() && proposal.sending_since.is_none(), "ERR_ALREADY_SENDING");
        proposal.cancelled = true;
        // Bonds and seeds go back; positions are refunded by claim_position.
        self.refund_on_cancel(id);
    }

    /// Sends proposal `id`, passed (or queued) and past its timelock, to the
    /// core and approves it there. Anyone may call it; attach 300 Tgas.
    pub fn execute(&mut self, id: u64) -> Promise {
        require!(env::prepaid_gas().saturating_sub(env::used_gas()) >= GAS_TO_SEND, "ERR_NOT_ENOUGH_GAS: attach 300 Tgas");
        let now = env::block_timestamp();
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        match self.state(proposal) {
            State::Succeeded | State::Queued => {}
            State::Expired => env::panic_str("ERR_EXECUTION_EXPIRED"),
            _ => env::panic_str("ERR_PROPOSAL_NOT_PASSED"),
        }
        let after = self.executable_after(proposal).expect("ERR_PROPOSAL_NOT_PASSED");
        require!(now >= after, "ERR_TIMELOCK");
        let proposal = self.proposals.get_mut(&id).unwrap();
        if let Some(since) = proposal.sending_since {
            require!(now > since + SEND_TIMEOUT_NS, "ERR_ALREADY_SENDING");
        }
        proposal.sending_since = Some(now);
        if proposal.core_id.is_some() {
            return self.approve_on_core(id);
        }
        match parse_kind(&proposal.kind) {
            Ok((_, KindClass::Swap { new_orbit })) => Promise::new(new_orbit)
                .function_call("get_dao", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_VIEW)
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

    #[private]
    pub fn on_swap_checked(&mut self, id: u64) -> PromiseOrValue<()> {
        if callback_value::<AccountId>().as_ref() == Some(&self.dao_id) {
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
                log!("The core refused proposal {}", id);
                self.end_send(id);
                PromiseOrValue::Value(())
            }
        }
    }

    #[private]
    pub fn on_approved(&mut self, id: u64) -> bool {
        let ok = env::promise_result_checked(0, MAX_RESULT_LEN).is_ok();
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        proposal.sending_since = None;
        if ok {
            proposal.executed = true;
            if let Some(Market::Sowellian(bet)) = &mut proposal.market {
                bet.measurement_deadline = Some(env::block_timestamp() + bet.measurement_period);
            }
        } else {
            log!("Core approval of proposal {} failed; call execute to retry", id);
        }
        ok
    }

    /// NEP-141 receiver for the DAO's token. The message says what the
    /// tokens are for: `{"challenge": id}` (optimistic), `{"proposal_bond":
    /// id}`, `{"position": id, "side": "Yes"|"No"}`, `{"resolve": id,
    /// "outcome": "Success"|"Failure"}`, `{"dispute": id}` (sowellian),
    /// `{"seed": id}`, `{"split": id}` (decision markets). Returns what isn't
    /// used; a refusal returns everything.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token_id, "ERR_WRONG_TOKEN");
        let msg: Value = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("ERR_INVALID_MESSAGE"));
        let id_of = |key: &str| msg.get(key).and_then(Value::as_u64);
        let unused = |n: u128| PromiseOrValue::Value(U128(n));
        #[cfg(feature = "optimistic")]
        if let Some(id) = id_of("challenge") {
            return unused(self.challenge_with_bond(id, sender_id, amount.0));
        }
        #[cfg(feature = "sowellian")]
        {
            if let Some(id) = id_of("proposal_bond") {
                return unused(self.pay_proposal_bond(id, sender_id, amount.0));
            }
            if let Some(id) = id_of("position") {
                let yes = match msg.get("side").and_then(Value::as_str) {
                    Some("Yes") => true,
                    Some("No") => false,
                    _ => env::panic_str("ERR_INVALID_MESSAGE: side"),
                };
                return unused(self.take_position(id, sender_id, amount.0, yes));
            }
            if let Some(id) = id_of("resolve") {
                let outcome = match msg.get("outcome").and_then(Value::as_str) {
                    Some("Success") => sowellian::Outcome::Success,
                    Some("Failure") => sowellian::Outcome::Failure,
                    _ => env::panic_str("ERR_INVALID_MESSAGE: outcome"),
                };
                return unused(self.propose_resolution(id, sender_id, amount.0, outcome));
            }
            if let Some(id) = id_of("dispute") {
                return unused(self.dispute_resolution(id, sender_id, amount.0));
            }
        }
        #[cfg(feature = "decision-markets")]
        {
            if let Some(id) = id_of("seed") {
                return unused(self.seed_base(id, sender_id, amount.0));
            }
            if let Some(id) = id_of("split") {
                return unused(self.split_base(id, sender_id, amount.0));
            }
        }
        env::panic_str("ERR_INVALID_MESSAGE")
    }

    /// Makes this orbit the staking contract's locker, once it governs the
    /// core (conviction needs it). Anyone may call it.
    pub fn claim_locker(&self) -> Promise {
        Promise::new(self.staking_id.clone()).function_call("claim_locker", b"{}".to_vec(), NearToken::from_yoctonear(0), Gas::from_tgas(40))
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

    pub fn get_model(&self) -> Model {
        self.model.clone()
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

    pub fn get_receipt(&self, id: u64, account_id: AccountId) -> Option<Receipt> {
        self.receipts.get(&(id, account_id)).cloned()
    }
}

impl Contract {
    /// Stores a new proposal, charging its storage to the attached deposit
    /// and refunding the rest. Returns its id.
    fn create_proposal(&mut self, proposer: &AccountId, description: String, kind: String, activated: bool, market: Option<Market>) -> u64 {
        require!(description.len() <= MAX_DESCRIPTION_LEN, "ERR_DESCRIPTION_TOO_LONG");
        require!(kind.len() <= MAX_KIND_LEN, "ERR_KIND_TOO_LONG");
        let (kind_value, _) = parse_kind(&kind).unwrap_or_else(|err| env::panic_str(err));
        let now = env::block_timestamp();
        let (start, end) = self.voting_window(now);
        let required = match &self.model {
            Model::Conviction(c) => conviction::required_conviction(c, &kind_value, &self.token_id),
            _ => 0,
        };
        let storage_before = env::storage_usage();
        let id = self.proposal_count;
        self.proposals.insert(
            id,
            Proposal {
                proposer: proposer.clone(),
                description,
                kind,
                created_at: now,
                start,
                end,
                activated,
                cancelled: false,
                executed: false,
                for_: 0,
                against: 0,
                abstain: 0,
                voters: 0,
                total: None,
                deposit: NearToken::from_yoctonear(0),
                core_id: None,
                sending_since: None,
                challenger: None,
                bond_resolved: false,
                conviction: 0,
                conviction_at: now,
                support: 0,
                required,
                queued_at: None,
                market,
            },
        );
        self.proposal_count += 1;
        self.proposals.flush();
        let cost = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage().saturating_sub(storage_before)));
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("ERR_DEPOSIT: attach at least {} yoctoNEAR", cost.as_yoctonear()));
        self.proposals.get_mut(&id).unwrap().deposit = cost;
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(proposer.clone()).transfer(refund).detach();
        }
        id
    }

    /// Restarts a proposal's voting window from now: when it activates late
    /// (a Sowellian bond arriving), voting runs from then.
    pub(crate) fn activate_now(&mut self, id: u64) {
        let now = env::block_timestamp();
        let (start, end) = self.voting_window(now);
        let p = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        p.activated = true;
        p.created_at = now;
        p.start = start;
        p.end = end;
    }

    /// Pays `amount` of the DAO's token to `receiver`; nothing for 0.
    pub(crate) fn pay_token(&self, receiver: &AccountId, amount: u128) {
        if amount > 0 {
            self.transfer_token(receiver, amount).detach();
        }
    }

    /// What a cancelled proposal gives back: a Sowellian proposal bond, or
    /// decision-market seeds if the markets never opened.
    fn refund_on_cancel(&mut self, id: u64) {
        match &self.model {
            #[cfg(feature = "sowellian")]
            Model::Sowellian(_) => self.refund_sowellian_bond(id),
            #[cfg(feature = "decision-markets")]
            Model::DecisionMarkets(_) => self.refund_seeds(id),
            _ => {}
        }
    }

    /// Sends `amount` yoctoNEAR to `receiver`.
    pub(crate) fn transfer_near(&self, receiver: &AccountId, amount: u128) {
        if amount > 0 {
            Promise::new(receiver.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
        }
    }
}

impl Contract {
    /// When voting starts and ends for a proposal made `now`.
    fn voting_window(&self, now: u64) -> (u64, u64) {
        match &self.model {
            Model::TokenWeighted(r) | Model::Quadratic(r) | Model::Liquid(r) => {
                let start = now + r.voting_delay.0;
                (start, start + r.voting_period.0)
            }
            Model::Optimistic { challenge_period, .. } => (now, now + challenge_period.0),
            Model::Conviction(_) => (now, now),
            Model::Delegate(d) => {
                let start = now + d.council.voting_delay.0;
                (start, start + d.council.voting_period.0)
            }
            Model::Sortition(s) => {
                let start = now + s.council.voting_delay.0;
                (start, start + s.council.voting_period.0)
            }
            Model::Sowellian(s) => {
                let start = now + s.approval.voting_delay.0;
                (start, start + s.approval.voting_period.0)
            }
            // The trading window is set when the markets open.
            Model::DecisionMarkets(_) => (now, now),
        }
    }

    pub(crate) fn state(&self, p: &Proposal) -> State {
        if p.cancelled {
            return State::Cancelled;
        }
        if p.executed {
            return State::Executed;
        }
        if !p.activated {
            return State::Pending;
        }
        let now = env::block_timestamp();
        let passed = match &self.model {
            Model::Conviction(_) => {
                return match p.queued_at {
                    Some(_) if self.past_window(p) => State::Expired,
                    Some(_) => State::Queued,
                    None => State::Active,
                };
            }
            Model::Sowellian(rules) => {
                if now < p.start {
                    return State::Pending;
                }
                if now <= p.end {
                    return State::Active;
                }
                let r = &rules.approval;
                if !passes(p.for_, p.against, p.abstain, p.total.unwrap_or(0), r.quorum_bps, r.approval_bps) {
                    return State::Defeated;
                }
                if now <= p.end + rules.positions_window.0 {
                    return State::Positions;
                }
                true
            }
            #[cfg(feature = "decision-markets")]
            Model::DecisionMarkets(rules) => {
                if now < p.end {
                    return State::Active;
                }
                match &p.market {
                    Some(Market::Decision(exchange)) => exchange.passed(rules.threshold_bps),
                    _ => false,
                }
            }
            Model::Optimistic { rules, .. } => match p.challenger {
                None if now <= p.end => return State::ChallengeWindow,
                None => true,
                Some(_) if now <= p.end => return State::Active,
                Some(_) => passes(p.for_, p.against, p.abstain, p.total.unwrap_or(0), rules.quorum_bps, rules.approval_bps),
            },
            _ => {
                if now < p.start {
                    return State::Pending;
                }
                if now <= p.end {
                    return State::Active;
                }
                match self.model.council() {
                    Some(c) => council::council_passes(p, c),
                    None => {
                        let r = self.model.vote_rules().unwrap();
                        passes(p.for_, p.against, p.abstain, p.total.unwrap_or(0), r.quorum_bps, r.approval_bps)
                    }
                }
            }
        };
        match (passed, self.past_window(p)) {
            (false, _) => State::Defeated,
            (true, true) => State::Expired,
            (true, false) => State::Succeeded,
        }
    }

    /// When a passed or queued proposal may execute.
    fn executable_after(&self, p: &Proposal) -> Option<u64> {
        let (timelock, _) = self.model.execution();
        let base = match &self.model {
            Model::Conviction(_) => p.queued_at?,
            Model::Sowellian(s) => p.end + s.positions_window.0,
            _ => p.end,
        };
        Some(base + timelock)
    }

    fn past_window(&self, p: &Proposal) -> bool {
        let (_, window) = self.model.execution();
        self.executable_after(p).is_some_and(|after| env::block_timestamp() > after + window)
    }

    fn view(&self, id: u64, p: &Proposal) -> ProposalView {
        let state = self.state(p);
        ProposalView {
            id,
            proposer: p.proposer.clone(),
            description: p.description.clone(),
            kind: serde_json::from_str(&p.kind).unwrap_or(Value::Null),
            state,
            snapshot: U64(p.created_at),
            start: U64(p.start),
            end: U64(p.end),
            executable_after: matches!(state, State::Succeeded | State::Queued).then(|| self.executable_after(p).map(U64)).flatten(),
            for_votes: U128(p.for_),
            against_votes: U128(p.against),
            abstain_votes: U128(p.abstain),
            voters: p.voters,
            total: p.total.map(U128),
            challenger: p.challenger.clone(),
            conviction: U128(match &self.model {
                Model::Conviction(c) => conviction::settled(p, c, env::block_timestamp()).0,
                _ => 0,
            }),
            support: U128(p.support),
            required_conviction: U128(p.required),
            core_proposal_id: p.core_id,
            sending: p.sending_since.is_some(),
        }
    }

    /// Reads `account_id`'s stake and the total stake at `timestamp`.
    pub(crate) fn weights_at(&self, account_id: &AccountId, timestamp: u64) -> Promise {
        Promise::new(self.staking_id.clone()).function_call(
            "weights_at",
            json!({ "account_id": account_id, "timestamp": U64(timestamp) }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_VIEW,
        )
    }

    fn add_to_core(&self, id: u64) -> Promise {
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        let kind: Value = serde_json::from_str(&proposal.kind).expect("ERR_KIND_NOT_JSON");
        Promise::new(self.dao_id.clone())
            .function_call("add_proposal", add_proposal_args(&proposal.description, &kind), NearToken::from_yoctonear(0), GAS_ADD_PROPOSAL)
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
            .function_call_weight("act_proposal", act_proposal_args(core_id, &kind), NearToken::from_yoctonear(0), GAS_ACT_PROPOSAL, GasWeight(1))
            // All leftover gas to act_proposal, which runs the proposal's own calls; the callback needs only its own.
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).with_unused_gas_weight(0).on_approved(id))
    }

    fn end_send(&mut self, id: u64) {
        self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL").sending_since = None;
    }

    /// Sends `amount` of the DAO's token to `receiver`.
    pub(crate) fn transfer_token(&self, receiver: &AccountId, amount: u128) -> Promise {
        Promise::new(self.token_id.clone()).function_call(
            "ft_transfer",
            json!({ "receiver_id": receiver, "amount": U128(amount) }).to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            GAS_FT_TRANSFER,
        )
    }
}

/// The JSON value the previous call returned, or `None` if it failed or
/// returned something else. Never panics, so a callback always records the
/// outcome.
pub(crate) fn callback_value<T: DeserializeOwned>() -> Option<T> {
    let bytes = env::promise_result_checked(0, MAX_RESULT_LEN).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests;
