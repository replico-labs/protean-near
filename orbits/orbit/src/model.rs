//! The governance models an orbit can run, and their settings. They follow
//! Protean's EVM models (Spaces); times are in nanoseconds, shares in basis
//! points (10_000 = 100%).

use near_sdk::json_types::{U64, U128};
use near_sdk::{near, require};

pub const MAX_BPS: u16 = 10_000;

/// Rules for models that hold one vote per proposal, weighted by stake at
/// the proposal's snapshot.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteRules {
    /// Turnout (for + against + abstain) needed, as a share of total stake.
    pub quorum_bps: u16,
    /// For / (for + against) needed.
    pub approval_bps: u16,
    /// From proposing to the start of voting.
    pub voting_delay: U64,
    pub voting_period: U64,
    /// From the end of voting until it may execute.
    pub timelock: U64,
    /// How long after the timelock it may still execute.
    pub execution_period: U64,
    /// Stake needed to propose (raw, never square-rooted). 0: anyone.
    pub proposal_threshold: U128,
}

/// Rules for council votes: one seat, one vote.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CouncilRules {
    /// Council members who must vote.
    pub quorum: u16,
    pub approval_bps: u16,
    pub voting_delay: U64,
    pub voting_period: U64,
    pub timelock: U64,
    pub execution_period: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Model {
    /// One staked token, one vote.
    TokenWeighted(VoteRules),
    /// Voting weight is the square root of stake; quorum is measured
    /// against the square root of total stake.
    Quadratic(VoteRules),
    /// Token-weighted, and anyone may delegate their vote; a delegator's
    /// weight follows their delegation chain to the first account that voted.
    Liquid(VoteRules),
    /// Passes after `challenge_period` unless someone posts `challenge_bond`
    /// of the token, which starts a token-weighted vote (`rules`; its voting
    /// delay is unused). The bond goes to the treasury if the proposal
    /// passes anyway, and back to the challenger if it fails.
    Optimistic { rules: VoteRules, challenge_period: U64, challenge_bond: U128 },
    /// Members back one proposal at a time with their locked stake; support
    /// turns into conviction over time, and a proposal may queue once its
    /// conviction reaches what it requires.
    Conviction(ConvictionRules),
    /// Stakers elect a council for a term, and may recall its members; the
    /// council proposes and votes.
    Delegate(DelegateRules),
    /// A council drawn at random from stakers who opted in, for a term.
    Sortition(SortitionRules),
    /// Outcome-based: stakers approve a proposal and its success criteria,
    /// a pari-mutuel YES/NO market takes positions in the DAO's token, the
    /// proposal executes, and after its measurement period the outcome is
    /// resolved by an oracle or by a bonded resolver, open to challenge and
    /// a stake-weighted adjudication vote.
    Sowellian(SowellianRules),
    /// Futarchy: each proposal gets a pass market and a fail market, and
    /// whichever prices the DAO's token higher over the trading window,
    /// by time-weighted average, decides.
    DecisionMarkets(DecisionRules),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SowellianRules {
    /// The approval vote. Its timelock runs from the end of the positions
    /// window; its proposal threshold is unused (the bond gates proposals).
    pub approval: VoteRules,
    /// In the DAO's token: returned once the proposal is resolved, kept by
    /// the treasury if approval fails.
    pub proposal_bond: U128,
    /// How long YES/NO positions may be taken after approval.
    pub positions_window: U64,
    pub resolution_bond: U128,
    /// How long a proposed resolution may be challenged.
    pub challenge_period: U64,
    pub challenge_bond: U128,
    pub adjudication_period: U64,
    pub adjudication_quorum_bps: u16,
    /// Share of adjudication votes that must say Success.
    pub adjudication_threshold_bps: u16,
    /// Oracle data older than this is refused.
    pub max_oracle_staleness: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionRules {
    pub trading_period: U64,
    /// How far the pass market's price must exceed the fail market's.
    pub threshold_bps: u16,
    pub timelock: U64,
    pub execution_period: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ConvictionRules {
    /// How fast conviction moves toward a proposal's current support, in
    /// stake units per second.
    pub growth_per_second: U128,
    /// Conviction every proposal requires.
    pub min_conviction: U128,
    /// Extra conviction per unit paid out, scaled by 10^24: for NEAR, 50
    /// means 50 per NEAR; for an 18-decimal token, 10^7 means 10 per token.
    pub near_multiplier: U128,
    pub token_multiplier: U128,
    /// What any other action requires: function calls, policy changes,
    /// swaps, other tokens. It should be high.
    pub governance_conviction: U128,
    pub timelock: U64,
    pub execution_period: U64,
    pub proposal_threshold: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DelegateRules {
    pub council: CouncilRules,
    pub council_size: u16,
    pub term_length: U64,
    /// Stake needed to stand for election and to start a recall.
    pub candidacy_threshold: U128,
    pub candidacy_period: U64,
    pub election_period: U64,
    pub recall_quorum_bps: u16,
    pub recall_approval_bps: u16,
    pub recall_period: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SortitionRules {
    pub council: CouncilRules,
    pub council_size: u16,
    pub term_length: U64,
    /// Stake needed to enter the pool.
    pub eligibility_threshold: U128,
}

fn check_bps(bps: u16) {
    require!(bps > 0 && bps <= MAX_BPS, "ERR_CONFIG: shares must be 1-10000 basis points");
}

impl VoteRules {
    fn validate(&self) {
        check_bps(self.quorum_bps);
        check_bps(self.approval_bps);
        require!(self.voting_period.0 > 0, "ERR_CONFIG: voting_period");
    }
}

impl CouncilRules {
    fn validate(&self, council_size: u16) {
        check_bps(self.approval_bps);
        require!(self.quorum > 0 && self.quorum <= council_size, "ERR_CONFIG: council quorum");
        require!(self.voting_period.0 > 0, "ERR_CONFIG: voting_period");
    }
}

impl Model {
    pub fn validate(&self) {
        match self {
            Model::TokenWeighted(r) | Model::Quadratic(r) | Model::Liquid(r) => r.validate(),
            Model::Optimistic { rules, challenge_period, challenge_bond } => {
                rules.validate();
                require!(challenge_period.0 > 0 && challenge_bond.0 > 0, "ERR_CONFIG: challenge");
            }
            Model::Conviction(c) => {
                require!(c.growth_per_second.0 > 0 && c.min_conviction.0 > 0, "ERR_CONFIG: conviction");
                require!(c.governance_conviction.0 >= c.min_conviction.0, "ERR_CONFIG: governance_conviction");
            }
            Model::Delegate(d) => {
                require!(d.council_size > 0, "ERR_CONFIG: council_size");
                d.council.validate(d.council_size);
                check_bps(d.recall_quorum_bps);
                check_bps(d.recall_approval_bps);
                require!(d.term_length.0 > 0 && d.election_period.0 > 0 && d.recall_period.0 > 0, "ERR_CONFIG: periods");
            }
            Model::Sortition(s) => {
                require!(s.council_size > 0, "ERR_CONFIG: council_size");
                s.council.validate(s.council_size);
                require!(s.term_length.0 > 0, "ERR_CONFIG: term_length");
            }
            Model::Sowellian(s) => {
                s.approval.validate();
                check_bps(s.adjudication_quorum_bps);
                check_bps(s.adjudication_threshold_bps);
                require!(s.resolution_bond.0 > 0 && s.challenge_bond.0 > 0, "ERR_CONFIG: bonds");
                require!(s.positions_window.0 > 0 && s.challenge_period.0 > 0 && s.adjudication_period.0 > 0, "ERR_CONFIG: periods");
            }
            Model::DecisionMarkets(d) => {
                require!(d.trading_period.0 > 0, "ERR_CONFIG: trading_period");
                require!(d.threshold_bps <= MAX_BPS, "ERR_CONFIG: threshold_bps");
            }
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Model::TokenWeighted(_) => "tokenWeighted",
            Model::Quadratic(_) => "quadratic",
            Model::Liquid(_) => "liquid",
            Model::Optimistic { .. } => "optimistic",
            Model::Conviction(_) => "conviction",
            Model::Delegate(_) => "delegate",
            Model::Sortition(_) => "sortition",
            Model::Sowellian(_) => "sowellian",
            Model::DecisionMarkets(_) => "decisionMarkets",
        }
    }

    /// The council rules, for council models.
    pub fn council(&self) -> Option<&CouncilRules> {
        match self {
            Model::Delegate(d) => Some(&d.council),
            Model::Sortition(s) => Some(&s.council),
            _ => None,
        }
    }

    /// The vote rules, for models with a stake-weighted vote.
    pub fn vote_rules(&self) -> Option<&VoteRules> {
        match self {
            Model::TokenWeighted(r) | Model::Quadratic(r) | Model::Liquid(r) => Some(r),
            Model::Optimistic { rules, .. } => Some(rules),
            Model::Sowellian(s) => Some(&s.approval),
            _ => None,
        }
    }

    pub fn proposal_threshold(&self) -> u128 {
        match self {
            Model::Conviction(c) => c.proposal_threshold.0,
            Model::Sowellian(_) | Model::DecisionMarkets(_) => 0,
            _ => self.vote_rules().map_or(0, |r| r.proposal_threshold.0),
        }
    }

    /// Timelock and execution window, the same for every model.
    pub fn execution(&self) -> (u64, u64) {
        match self {
            Model::Conviction(c) => (c.timelock.0, c.execution_period.0),
            Model::DecisionMarkets(d) => (d.timelock.0, d.execution_period.0),
            _ => match (self.vote_rules(), self.council()) {
                (Some(r), _) => (r.timelock.0, r.execution_period.0),
                (_, Some(c)) => (c.timelock.0, c.execution_period.0),
                _ => unreachable!(),
            },
        }
    }
}

/// Integer square root, rounded down.
pub fn isqrt(x: u128) -> u128 {
    if x < 2 {
        return x;
    }
    // Start from the float estimate, then correct it exactly.
    let mut r = ((x as f64).sqrt() as u128).min(u128::from(u64::MAX));
    while r.checked_mul(r).is_none_or(|sq| sq > x) {
        r -= 1;
    }
    while (r + 1).checked_mul(r + 1).is_some_and(|sq| sq <= x) {
        r += 1;
    }
    r
}

/// Spaces' pass rule: turnout reaches the quorum share of `total`, and for
/// reaches the approval share of for + against.
pub fn passes(for_: u128, against: u128, abstain: u128, total: u128, quorum_bps: u16, approval_bps: u16) -> bool {
    let turnout = for_ + against + abstain;
    let decisive = for_ + against;
    total > 0
        && mul_bps_ge(turnout, total, quorum_bps)
        && decisive > 0
        && mul_bps_ge(for_, decisive, approval_bps)
}

/// part / whole >= bps / 10_000, exactly: part * 10_000 >= whole * bps.
fn mul_bps_ge(part: u128, whole: u128, bps: u16) -> bool {
    mul_wide(part, MAX_BPS) >= mul_wide(whole, bps)
}

/// a * b as (high, low) with high = a*b >> 64 and low = the bottom 64 bits,
/// which can't overflow for a 16-bit b. Compares in the right order as a tuple.
fn mul_wide(a: u128, b: u16) -> (u128, u128) {
    let b = u128::from(b);
    let (high, low) = (a >> 64, a & u128::from(u64::MAX));
    let low_product = low * b;
    (high * b + (low_product >> 64), low_product & u128::from(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_is_exact_floor() {
        for x in [0u128, 1, 2, 3, 4, 15, 16, 17, 99, 100, 10u128.pow(30), u128::MAX] {
            let r = isqrt(x);
            assert!(r * r <= x, "{x}");
            assert!((r + 1).checked_mul(r + 1).is_none_or(|s| s > x), "{x}");
        }
    }

    #[test]
    fn pass_rule_matches_spaces() {
        // 40% quorum, 50% approval, total 100.
        assert!(passes(30, 10, 0, 100, 4000, 5000));
        assert!(!passes(30, 9, 0, 100, 4000, 5000), "39% turnout misses quorum");
        assert!(passes(20, 20, 0, 100, 4000, 5000), "a tie meets 50%");
        assert!(!passes(19, 21, 0, 100, 4000, 5000));
        assert!(!passes(0, 0, 40, 100, 4000, 5000), "abstain alone counts for quorum, not approval");
        assert!(!passes(10, 0, 0, 0, 4000, 5000), "no stake, no pass");
        let big = 10u128.pow(36);
        assert!(passes(big, 0, 0, big, 10_000, 10_000));
    }
}
