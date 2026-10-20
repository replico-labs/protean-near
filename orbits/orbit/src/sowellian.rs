//! Sowellian governance, as in Spaces: stakers approve a proposal together
//! with its success criteria; a pari-mutuel YES/NO market takes positions in
//! the DAO's token; the proposal executes; after its measurement period the
//! outcome is resolved, by an oracle or by a bonded resolver whose answer
//! can be challenged and adjudicated by a stake-weighted vote. Winning
//! positions share the whole pool.
//!
//! Tokens arrive with `ft_transfer_call` (lib.rs routes them by message):
//! the proposal bond, positions, the resolution bond and the challenge bond.
//!
//! The approval vote uses the shared stake-weighted vote (ballot.rs). The
//! adjudication vote counts stake at the end of approval, before any
//! position could be taken, so betting never shrinks a voice.
//!
//! An oracle is any contract with `latest_value({"selector": ...})`
//! returning `[value, updated_at]` (I128 and U64 as strings), the NEAR form
//! of Spaces' IMetricOracle.

use super::*;
use near_sdk::json_types::I128;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Success,
    Failure,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Criteria {
    /// Success if the oracle's value for `selector` ends at least
    /// (`minimum`) or at most `target`.
    Oracle { oracle: AccountId, selector: String, target: I128, minimum: bool },
    /// A bonded resolver proposes the outcome.
    Human,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Bet {
    criteria: Criteria,
    pub(crate) measurement_period: u64,
    bond: u128,
    bond_settled: bool,
    yes_pool: u128,
    no_pool: u128,
    /// Set when the proposal executes on the core.
    pub(crate) measurement_deadline: Option<u64>,
    resolver: Option<AccountId>,
    proposed: Option<Outcome>,
    challenge_deadline: u64,
    challenger: Option<AccountId>,
    adjudication_end: u64,
    success_votes: u128,
    failure_votes: u128,
    total: Option<u128>,
    outcome: Option<Outcome>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Position {
    pub yes: U128,
    pub no: U128,
    pub claimed: bool,
}

#[near(serializers = [json])]
pub struct BetView {
    pub criteria: Criteria,
    pub measurement_period: U64,
    pub measurement_deadline: Option<U64>,
    pub proposal_bond: U128,
    pub yes_pool: U128,
    pub no_pool: U128,
    pub resolver: Option<AccountId>,
    pub proposed_outcome: Option<Outcome>,
    pub challenge_deadline: Option<U64>,
    pub challenger: Option<AccountId>,
    pub adjudication_end: Option<U64>,
    pub success_votes: U128,
    pub failure_votes: U128,
    pub outcome: Option<Outcome>,
}

#[near]
impl Contract {
    /// Sowellian: proposes `kind` with its success criteria, measured over
    /// `measurement_period` after it executes. With a proposal bond, voting
    /// opens once the bond arrives (`{"proposal_bond": id}`).
    #[payable]
    pub fn propose_with_criteria(&mut self, description: String, kind: String, criteria: Criteria, measurement_period: U64) -> u64 {
        let bond = self.sowellian_rules().proposal_bond.0;
        require!(measurement_period.0 > 0, "ERR_MEASUREMENT_PERIOD");
        let bet = Bet {
            criteria,
            measurement_period: measurement_period.0,
            bond,
            bond_settled: bond == 0,
            yes_pool: 0,
            no_pool: 0,
            measurement_deadline: None,
            resolver: None,
            proposed: None,
            challenge_deadline: 0,
            challenger: None,
            adjudication_end: 0,
            success_votes: 0,
            failure_votes: 0,
            total: None,
            outcome: None,
        };
        let proposer = env::predecessor_account_id();
        self.create_proposal(&proposer, description, kind, bond == 0, Some(Market::Sowellian(bet)))
    }

    /// Resolves an oracle-track proposal once its measurement period is over.
    pub fn resolve_via_oracle(&mut self, id: u64) -> Promise {
        let (bet, _) = self.bet(id);
        let Criteria::Oracle { oracle, selector, .. } = bet.criteria.clone() else {
            env::panic_str("ERR_NOT_ORACLE_TRACK");
        };
        require!(bet.outcome.is_none(), "ERR_RESOLVED");
        let deadline = bet.measurement_deadline.expect("ERR_NOT_EXECUTED");
        require!(env::block_timestamp() >= deadline, "ERR_MEASUREMENT_NOT_OVER");
        Promise::new(oracle)
            .function_call("latest_value", json!({ "selector": selector }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_VIEW)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_oracle_value(id))
    }

    #[private]
    pub fn on_oracle_value(&mut self, id: u64) -> Option<Outcome> {
        let staleness = self.sowellian_rules().max_oracle_staleness.0;
        let now = env::block_timestamp();
        let Some((value, updated_at)) = callback_value::<(I128, U64)>() else {
            log!("The oracle gave no value for proposal {}", id);
            return None;
        };
        if now > updated_at.0.saturating_add(staleness) {
            log!("The oracle's value for proposal {} is stale", id);
            return None;
        }
        let (bet, proposer) = self.bet_mut(id);
        if bet.outcome.is_some() {
            return bet.outcome;
        }
        let Criteria::Oracle { target, minimum, .. } = &bet.criteria else { unreachable!() };
        let success = if *minimum { value.0 >= target.0 } else { value.0 <= target.0 };
        let outcome = if success { Outcome::Success } else { Outcome::Failure };
        bet.outcome = Some(outcome);
        let bond = bet.settle_bond();
        self.pay_token(&proposer, bond);
        Some(outcome)
    }

    /// Adjudication vote on a disputed resolution, with stake at the end of approval.
    pub fn adjudicate(&mut self, id: u64, outcome: Outcome) -> Promise {
        let voter = env::predecessor_account_id();
        let snapshot = self.proposals.get(&id).expect("ERR_NO_PROPOSAL").end;
        let (bet, _) = self.bet(id);
        require!(bet.challenger.is_some() && bet.outcome.is_none(), "ERR_NOT_ADJUDICATING");
        require!(env::block_timestamp() <= bet.adjudication_end, "ERR_ADJUDICATION_CLOSED");
        require!(!self.adjudication_voters.contains_key(&(id, voter.clone())), "ERR_ALREADY_VOTED");
        self.adjudication_voters.insert((id, voter.clone()), true);
        self.weights_at(&voter, snapshot).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_adjudication_weight(id, voter, outcome),
        )
    }

    #[private]
    pub fn on_adjudication_weight(&mut self, id: u64, voter: AccountId, outcome: Outcome) -> U128 {
        let Some((own, total)) = callback_value::<(U128, U128)>().filter(|(own, _)| own.0 > 0) else {
            self.adjudication_voters.remove(&(id, voter));
            return U128(0);
        };
        let (bet, _) = self.bet_mut(id);
        bet.total.get_or_insert(total.0);
        match outcome {
            Outcome::Success => bet.success_votes += own.0,
            Outcome::Failure => bet.failure_votes += own.0,
        }
        self.adjudication_voters.insert((id, voter), false);
        own
    }

    /// Makes an unchallenged resolution final once its challenge window is
    /// over; returns the resolver's and the proposer's bonds.
    pub fn finalize_resolution(&mut self, id: u64) -> Outcome {
        let (bet, proposer) = self.bet_mut(id);
        require!(bet.outcome.is_none(), "ERR_RESOLVED");
        let resolver = bet.resolver.clone().expect("ERR_NO_RESOLUTION");
        require!(bet.challenger.is_none(), "ERR_DISPUTED");
        require!(env::block_timestamp() > bet.challenge_deadline, "ERR_CHALLENGE_WINDOW_OPEN");
        let outcome = bet.proposed.unwrap();
        bet.outcome = Some(outcome);
        let proposal_bond = bet.settle_bond();
        let resolution_bond = self.sowellian_rules().resolution_bond.0;
        self.pay_token(&resolver, resolution_bond);
        self.pay_token(&proposer, proposal_bond);
        outcome
    }

    /// Ends adjudication: Success needs the quorum and the threshold, else
    /// Failure. Whoever was right gets their bond back; the other's goes to
    /// the treasury. The proposer's bond is returned.
    pub fn finalize_adjudication(&mut self, id: u64) -> Outcome {
        let rules = self.sowellian_rules().clone();
        let dao = self.dao_id.clone();
        let (bet, proposer) = self.bet_mut(id);
        require!(bet.outcome.is_none(), "ERR_RESOLVED");
        let challenger = bet.challenger.clone().expect("ERR_NOT_ADJUDICATING");
        require!(env::block_timestamp() > bet.adjudication_end, "ERR_ADJUDICATION_NOT_OVER");
        let turnout = bet.success_votes + bet.failure_votes;
        let total = bet.total.unwrap_or(0);
        let success = total > 0
            && turnout * u128::from(MAX_BPS) >= total * u128::from(rules.adjudication_quorum_bps)
            && turnout > 0
            && bet.success_votes * u128::from(MAX_BPS) >= turnout * u128::from(rules.adjudication_threshold_bps);
        let outcome = if success { Outcome::Success } else { Outcome::Failure };
        bet.outcome = Some(outcome);
        let resolver_right = bet.proposed == Some(outcome);
        let resolver = bet.resolver.clone().unwrap();
        let proposal_bond = bet.settle_bond();
        let (resolution_to, challenge_to) = if resolver_right { (resolver, dao) } else { (dao, challenger) };
        self.pay_token(&resolution_to, rules.resolution_bond.0);
        self.pay_token(&challenge_to, rules.challenge_bond.0);
        self.pay_token(&proposer, proposal_bond);
        outcome
    }

    /// Keeps the proposal bond of a proposal that failed approval, for the treasury.
    pub fn forfeit_bond(&mut self, id: u64) {
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Defeated, "ERR_NOT_DEFEATED");
        let dao = self.dao_id.clone();
        let (bet, _) = self.bet_mut(id);
        let bond = bet.settle_bond();
        require!(bond > 0, "ERR_NO_BOND");
        self.pay_token(&dao, bond);
    }

    /// Pays the caller's position: winners share the whole pool in
    /// proportion to their stake. If the proposal never executed (cancelled
    /// or expired), every position is refunded.
    pub fn claim_position(&mut self, id: u64) -> U128 {
        let account = env::predecessor_account_id();
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        let refund = matches!(self.state(proposal), State::Cancelled | State::Expired);
        let (bet, _) = self.bet(id);
        let (outcome, yes_pool, no_pool) = (bet.outcome, bet.yes_pool, bet.no_pool);
        let key = (id, account.clone());
        let mut position = self.positions.get(&key).cloned().expect("ERR_NO_POSITION");
        require!(!position.claimed, "ERR_CLAIMED");
        let payout = match (refund, outcome) {
            (true, _) => position.yes.0 + position.no.0,
            (false, None) => env::panic_str("ERR_NOT_RESOLVED"),
            (false, Some(outcome)) => {
                let (stake, winning) = match outcome {
                    Outcome::Success => (position.yes.0, yes_pool),
                    Outcome::Failure => (position.no.0, no_pool),
                };
                if winning == 0 { 0 } else { mul_div(stake, yes_pool + no_pool, winning) }
            }
        };
        position.claimed = true;
        self.positions.insert(key, position);
        self.pay_token(&account, payout);
        U128(payout)
    }

    pub fn get_bet(&self, id: u64) -> Option<BetView> {
        match &self.proposals.get(&id)?.market {
            Some(Market::Sowellian(b)) => Some(BetView {
                criteria: b.criteria.clone(),
                measurement_period: U64(b.measurement_period),
                measurement_deadline: b.measurement_deadline.map(U64),
                proposal_bond: U128(b.bond),
                yes_pool: U128(b.yes_pool),
                no_pool: U128(b.no_pool),
                resolver: b.resolver.clone(),
                proposed_outcome: b.proposed,
                challenge_deadline: b.resolver.as_ref().map(|_| U64(b.challenge_deadline)),
                challenger: b.challenger.clone(),
                adjudication_end: b.challenger.as_ref().map(|_| U64(b.adjudication_end)),
                success_votes: U128(b.success_votes),
                failure_votes: U128(b.failure_votes),
                outcome: b.outcome,
            }),
            _ => None,
        }
    }

    pub fn get_position(&self, id: u64, account_id: AccountId) -> Option<Position> {
        self.positions.get(&(id, account_id)).cloned()
    }
}

impl Bet {
    /// The proposal bond, once: 0 if it was already paid out.
    fn settle_bond(&mut self) -> u128 {
        if self.bond_settled {
            return 0;
        }
        self.bond_settled = true;
        self.bond
    }
}

impl Contract {
    fn sowellian_rules(&self) -> &SowellianRules {
        match &self.model {
            Model::Sowellian(s) => s,
            _ => env::panic_str("ERR_NOT_SOWELLIAN"),
        }
    }

    fn bet(&self, id: u64) -> (&Bet, AccountId) {
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        match &proposal.market {
            Some(Market::Sowellian(bet)) => (bet, proposal.proposer.clone()),
            _ => env::panic_str("ERR_NOT_SOWELLIAN"),
        }
    }

    fn bet_mut(&mut self, id: u64) -> (&mut Bet, AccountId) {
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        let proposer = proposal.proposer.clone();
        match &mut proposal.market {
            Some(Market::Sowellian(bet)) => (bet, proposer),
            _ => env::panic_str("ERR_NOT_SOWELLIAN"),
        }
    }

    /// `{"proposal_bond": id}`: the proposer pays the bond and voting opens.
    pub(crate) fn pay_proposal_bond(&mut self, id: u64, sender: AccountId, amount: u128) -> u128 {
        let bond = self.sowellian_rules().proposal_bond.0;
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(proposal.proposer == sender, "ERR_NOT_PROPOSER");
        require!(!proposal.activated && !proposal.cancelled, "ERR_BOND_PAID");
        require!(amount >= bond, "ERR_BOND_TOO_SMALL");
        self.activate_now(id);
        amount - bond
    }

    /// `{"position": id, "side": ...}`: adds to the sender's YES or NO position.
    pub(crate) fn take_position(&mut self, id: u64, sender: AccountId, amount: u128, yes: bool) -> u128 {
        self.sowellian_rules();
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Positions, "ERR_POSITIONS_CLOSED");
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let (bet, _) = self.bet_mut(id);
        if yes { bet.yes_pool += amount } else { bet.no_pool += amount }
        let position = self.positions.entry((id, sender)).or_default();
        if yes { position.yes.0 += amount } else { position.no.0 += amount }
        0
    }

    /// `{"resolve": id, "outcome": ...}`: a human-track resolution, with its bond.
    pub(crate) fn propose_resolution(&mut self, id: u64, sender: AccountId, amount: u128, outcome: Outcome) -> u128 {
        let rules = self.sowellian_rules().clone();
        let now = env::block_timestamp();
        let (bet, _) = self.bet_mut(id);
        require!(bet.criteria == Criteria::Human, "ERR_NOT_HUMAN_TRACK");
        require!(bet.measurement_deadline.is_some_and(|d| now >= d), "ERR_MEASUREMENT_NOT_OVER");
        require!(bet.resolver.is_none(), "ERR_RESOLUTION_PROPOSED");
        require!(amount >= rules.resolution_bond.0, "ERR_BOND_TOO_SMALL");
        bet.resolver = Some(sender);
        bet.proposed = Some(outcome);
        bet.challenge_deadline = now + rules.challenge_period.0;
        amount - rules.resolution_bond.0
    }

    /// `{"dispute": id}`: challenges a proposed resolution, opening adjudication.
    pub(crate) fn dispute_resolution(&mut self, id: u64, sender: AccountId, amount: u128) -> u128 {
        let rules = self.sowellian_rules().clone();
        let now = env::block_timestamp();
        let (bet, _) = self.bet_mut(id);
        require!(bet.resolver.is_some() && bet.outcome.is_none(), "ERR_NO_RESOLUTION");
        require!(now <= bet.challenge_deadline, "ERR_CHALLENGE_WINDOW_CLOSED");
        require!(bet.challenger.is_none(), "ERR_DISPUTED");
        require!(amount >= rules.challenge_bond.0, "ERR_BOND_TOO_SMALL");
        bet.challenger = Some(sender);
        bet.adjudication_end = now + rules.adjudication_period.0;
        amount - rules.challenge_bond.0
    }

    /// On cancel: the proposal bond goes back to the proposer.
    pub(crate) fn refund_sowellian_bond(&mut self, id: u64) {
        let paid = self.proposals.get(&id).is_some_and(|p| p.activated);
        if !paid {
            return;
        }
        let (bet, proposer) = self.bet_mut(id);
        let bond = bet.settle_bond();
        self.pay_token(&proposer, bond);
    }
}

/// a * b / c, rounded down, without overflow.
pub(crate) fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    use markets::U256;
    let r = U256::from(a) * U256::from(b) / U256::from(c);
    if r > U256::from(u128::MAX) { u128::MAX } else { r.as_u128() }
}
