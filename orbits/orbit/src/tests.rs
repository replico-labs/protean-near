use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

use super::*;

const DAO: &str = "mydao.sputnikv2.testnet";
const ORBIT: &str = "orbit.mydao.orbits.testnet";
const STAKING: &str = "staking.mydao.orbits.testnet";
const TOKEN: &str = "token.mydao.orbits.testnet";
const SEC: u64 = 1_000_000_000;
const HOUR: u64 = 3_600 * SEC;
const TRANSFER: &str = r#"{"Transfer":{"token_id":"","receiver_id":"maya.testnet","amount":"1000000000000000000000000"}}"#;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// The test clock and caller.
struct Chain {
    now: u64,
}

impl Chain {
    fn call(&self, who: &str) {
        self.call_with(who, NearToken::from_near(0), vec![]);
    }

    fn pay(&self, who: &str, deposit: NearToken) {
        self.call_with(who, deposit, vec![]);
    }

    fn call_with(&self, who: &str, deposit: NearToken, results: Vec<PromiseResult>) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acc(ORBIT))
            .predecessor_account_id(acc(who))
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(5))
            .random_seed([7; 32])
            .block_timestamp(self.now);
        testing_env!(ctx.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }

    /// A callback into the orbit, with `result` as the previous call's answer.
    fn callback(&self, result: Option<String>) {
        let r = match result {
            Some(json) => PromiseResult::Successful(json.into_bytes()),
            None => PromiseResult::Failed,
        };
        self.call_with(ORBIT, NearToken::from_near(0), vec![r]);
    }
}

fn weights(own: u128, total: u128) -> Option<String> {
    Some(format!(r#"["{own}","{total}"]"#))
}

fn rules() -> VoteRules {
    VoteRules {
        quorum_bps: 4_000,
        approval_bps: 5_000,
        voting_delay: U64(HOUR),
        voting_period: U64(24 * HOUR),
        timelock: U64(HOUR),
        execution_period: U64(48 * HOUR),
        proposal_threshold: U128(0),
    }
}

fn council_rules() -> CouncilRules {
    CouncilRules { quorum: 2, approval_bps: 5_000, voting_delay: U64(0), voting_period: U64(24 * HOUR), timelock: U64(0), execution_period: U64(48 * HOUR) }
}

fn orbit(model: Model, council: Option<Vec<&str>>) -> (Chain, Contract) {
    let chain = Chain { now: 1_000 * HOUR };
    chain.call("deployer.testnet");
    let council = council.map(|c| c.into_iter().map(acc).collect());
    (chain, Contract::new(acc(DAO), acc(STAKING), acc(TOKEN), model, council))
}

fn propose(chain: &Chain, o: &mut Contract, who: &str, kind: &str) -> u64 {
    chain.pay(who, NearToken::from_millinear(100));
    match o.propose("pay maya".into(), kind.into()) {
        PromiseOrValue::Value(id) => id,
        PromiseOrValue::Promise(_) => o.proposal_count - 1,
    }
}

/// Votes and delivers the staking contract's answer.
fn vote(chain: &Chain, o: &mut Contract, id: u64, who: &str, choice: Choice, own: u128, total: u128) -> ballot::VoteOutcome {
    chain.call(who);
    let _ = o.vote(id, choice);
    chain.callback(weights(own, total));
    o.on_vote_weight(id, acc(who))
}

/// The proposal's state as of the chain's current time.
fn state(chain: &Chain, o: &Contract, id: u64) -> State {
    chain.call("viewer.testnet");
    o.get_proposal(id).unwrap().state
}

// --- Token-weighted ---

#[test]
fn token_weighted_lifecycle() {
    let (mut chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    assert_eq!(state(&chain, &o, id), State::Pending, "voting delay");
    chain.now += 2 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Active);
    vote(&chain, &mut o, id, "alice.testnet", Choice::For, 30, 100);
    vote(&chain, &mut o, id, "bob.testnet", Choice::Against, 10, 100);
    chain.now += 24 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Succeeded, "40% turnout, 75% for");
    let view = o.get_proposal(id).unwrap();
    assert_eq!(view.executable_after, Some(U64(view.end.0 + HOUR)));
}

#[test]
fn quorum_counts_abstain_but_approval_does_not() {
    let (mut chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.now += 2 * HOUR;
    vote(&chain, &mut o, id, "alice.testnet", Choice::For, 10, 100);
    vote(&chain, &mut o, id, "bob.testnet", Choice::Abstain, 29, 100);
    chain.now += 24 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Defeated, "39% turnout");
}

#[test]
fn a_vote_without_stake_is_dropped_and_can_be_retried() {
    let (mut chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.now += 2 * HOUR;
    let outcome = vote(&chain, &mut o, id, "dave.testnet", Choice::For, 0, 100);
    assert!(!outcome.counted);
    assert_eq!(o.get_receipt(id, acc("dave.testnet")), None);
    assert!(vote(&chain, &mut o, id, "dave.testnet", Choice::For, 5, 100).counted);
}

#[test]
#[should_panic(expected = "ERR_ALREADY_VOTED")]
fn a_pending_vote_blocks_a_second() {
    let (mut chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.now += 2 * HOUR;
    chain.call("alice.testnet");
    let _ = o.vote(id, Choice::For);
    let _ = o.vote(id, Choice::Against);
}

#[test]
#[should_panic(expected = "ERR_PROPOSAL_NOT_ACTIVE")]
fn no_voting_during_the_delay() {
    let (chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.call("alice.testnet");
    let _ = o.vote(id, Choice::For);
}

#[test]
fn proposal_threshold_activates_or_cancels_and_refunds() {
    let (mut chain, mut o) = orbit(Model::TokenWeighted(VoteRules { proposal_threshold: U128(50), ..rules() }), None);
    let ok = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.callback(weights(60, 100));
    o.on_proposer_stake(ok);
    let low = propose(&chain, &mut o, "dave.testnet", TRANSFER);
    chain.callback(weights(10, 100));
    o.on_proposer_stake(low);
    chain.now += 2 * HOUR;
    assert_eq!(state(&chain, &o, ok), State::Active);
    assert_eq!(state(&chain, &o, low), State::Cancelled);
}

#[test]
fn execute_respects_timelock_and_window() {
    let (mut chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.now += 2 * HOUR;
    vote(&chain, &mut o, id, "alice.testnet", Choice::For, 50, 100);
    chain.now += 23 * HOUR + 1_800 * SEC; // voting over, timelock not
    chain.call("anyone.testnet");
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.execute(id)));
    assert!(early.is_err(), "timelock");
    chain.now += HOUR;
    chain.call("anyone.testnet");
    let _ = o.execute(id);
    assert!(o.get_proposal(id).unwrap().sending);
    chain.callback(Some("4".into()));
    let _ = o.on_added(id);
    chain.callback(Some(String::new()));
    assert!(o.on_approved(id));
    let view = o.get_proposal(id).unwrap();
    assert_eq!((view.state, view.core_proposal_id), (State::Executed, Some(4)));
}

#[test]
fn passed_but_unexecuted_expires() {
    let (mut chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.now += 2 * HOUR;
    vote(&chain, &mut o, id, "alice.testnet", Choice::For, 50, 100);
    chain.now += 80 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Expired);
}

#[test]
fn only_the_proposer_cancels() {
    let (chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.call("bob.testnet");
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.cancel(id))).is_err());
    chain.call("alice.testnet");
    o.cancel(id);
    assert_eq!(state(&chain, &o, id), State::Cancelled);
}

#[test]
fn swap_goes_only_to_an_orbit_bound_to_this_core() {
    let (mut chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    let kind = orbit_common::swap_kind(&acc("q.mydao.orbits.testnet")).to_string();
    let id = propose(&chain, &mut o, "alice.testnet", &kind);
    chain.now += 2 * HOUR;
    vote(&chain, &mut o, id, "alice.testnet", Choice::For, 50, 100);
    chain.now += 26 * HOUR;
    chain.call("anyone.testnet");
    let _ = o.execute(id);
    chain.callback(Some(r#""other.sputnikv2.testnet""#.into()));
    let _ = o.on_swap_checked(id);
    assert!(get_logs()[0].contains("not sent"));
    assert!(!o.get_proposal(id).unwrap().sending);
    chain.call("anyone.testnet");
    let _ = o.execute(id);
    chain.callback(Some(format!("\"{DAO}\"")));
    let _ = o.on_swap_checked(id);
    assert_eq!(get_created_receipts().len(), 2, "add_proposal, then on_added");
}

#[test]
#[should_panic(expected = "ERR_KIND_LOCKS_CORE")]
fn proposals_that_lock_the_core_are_refused() {
    let (chain, mut o) = orbit(Model::TokenWeighted(rules()), None);
    propose(&chain, &mut o, "alice.testnet", r#"{"ChangePolicyRemoveRole":{"role":"governance"}}"#);
}

// --- Quadratic ---

#[test]
fn quadratic_weighs_the_square_root() {
    let (mut chain, mut o) = orbit(Model::Quadratic(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.now += 2 * HOUR;
    // A whale with 81 against two members with 9 each: 9 vs 3 + 3.
    vote(&chain, &mut o, id, "whale.testnet", Choice::Against, 81, 100);
    vote(&chain, &mut o, id, "a.testnet", Choice::For, 9, 100);
    vote(&chain, &mut o, id, "b.testnet", Choice::For, 9, 100);
    let view = o.get_proposal(id).unwrap();
    assert_eq!((view.for_votes.0, view.against_votes.0, view.total), (6, 9, Some(U128(10))));
}

// --- Liquid ---

#[test]
fn liquid_delegation_follows_the_chain_to_a_voter() {
    let (mut chain, mut o) = orbit(Model::Liquid(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.call("carol.testnet");
    o.delegate(acc("bob.testnet"));
    chain.call("bob.testnet");
    o.delegate(acc("alice.testnet"));
    assert_eq!(o.get_chain_tip(acc("carol.testnet")), (acc("alice.testnet"), 2));
    chain.now += 2 * HOUR;
    vote(&chain, &mut o, id, "alice.testnet", Choice::For, 20, 100);
    chain.call("anyone.testnet");
    let _ = o.resolve_delegated_vote(id, acc("carol.testnet"));
    chain.callback(weights(30, 100));
    o.on_vote_weight(id, acc("carol.testnet"));
    let receipt = o.get_receipt(id, acc("carol.testnet")).unwrap();
    assert_eq!((receipt.choice, receipt.via), (Choice::For, Some(acc("alice.testnet"))));
    assert_eq!(o.get_proposal(id).unwrap().for_votes.0, 50);
}

#[test]
#[should_panic(expected = "ERR_DELEGATE_HAS_NOT_VOTED")]
fn liquid_resolution_needs_a_voter_in_the_chain() {
    let (mut chain, mut o) = orbit(Model::Liquid(rules()), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.call("carol.testnet");
    o.delegate(acc("bob.testnet"));
    chain.now += 2 * HOUR;
    chain.call("anyone.testnet");
    let _ = o.resolve_delegated_vote(id, acc("carol.testnet"));
}

// --- Optimistic ---

fn optimistic() -> Model {
    Model::Optimistic { rules: rules(), challenge_period: U64(24 * HOUR), challenge_bond: U128(100) }
}

#[test]
fn optimistic_passes_unless_challenged() {
    let (mut chain, mut o) = orbit(optimistic(), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    assert_eq!(state(&chain, &o, id), State::ChallengeWindow);
    chain.now += 25 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Succeeded);
}

/// Challenges a proposal, runs its vote, resolves the bond and returns who got it.
fn challenge_outcome(for_: u128, against: u128) -> (State, String) {
    let (mut chain, mut o) = orbit(optimistic(), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.call(TOKEN);
    let refund = o.ft_on_transfer(acc("critic.testnet"), U128(150), format!(r#"{{"challenge":{id}}}"#));
    assert!(matches!(refund, PromiseOrValue::Value(U128(50))), "the excess over the bond comes back");
    assert_eq!(state(&chain, &o, id), State::Active);
    vote(&chain, &mut o, id, "a.testnet", Choice::For, for_, 100);
    vote(&chain, &mut o, id, "b.testnet", Choice::Against, against, 100);
    chain.now += 25 * HOUR;
    let end_state = state(&chain, &o, id);
    chain.call("anyone.testnet");
    let _ = o.resolve_challenge(id);
    let receipt = &get_created_receipts()[0];
    assert_eq!(receipt.receiver_id, acc(TOKEN));
    let near_sdk::mock::MockAction::FunctionCallWeight { args, .. } = &receipt.actions[0] else { panic!("ft_transfer expected") };
    let args: Value = serde_json::from_slice(args).unwrap();
    (end_state, args["receiver_id"].as_str().unwrap().to_string())
}

#[test]
fn a_failed_challenge_forfeits_the_bond_to_the_treasury() {
    assert_eq!(challenge_outcome(60, 10), (State::Succeeded, DAO.to_string()));
}

#[test]
fn a_successful_challenge_returns_the_bond() {
    assert_eq!(challenge_outcome(10, 60), (State::Defeated, "critic.testnet".to_string()));
}

#[test]
#[should_panic(expected = "ERR_NOT_CHALLENGEABLE")]
fn no_challenge_after_the_window() {
    let (mut chain, mut o) = orbit(optimistic(), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.now += 25 * HOUR;
    chain.call(TOKEN);
    let _ = o.ft_on_transfer(acc("critic.testnet"), U128(100), format!(r#"{{"challenge":{id}}}"#));
}

// --- Conviction ---

fn conviction() -> Model {
    Model::Conviction(ConvictionRules {
        growth_per_second: U128(1),
        min_conviction: U128(100),
        near_multiplier: U128(50), // 50 conviction per NEAR
        token_multiplier: U128(0),
        governance_conviction: U128(10_000),
        timelock: U64(0),
        execution_period: U64(48 * HOUR),
        proposal_threshold: U128(0),
    })
}

fn support(chain: &Chain, o: &mut Contract, id: u64, who: &str, locked: u128) {
    chain.call(who);
    let _ = o.support(id);
    chain.callback(Some(format!("\"{locked}\"")));
    o.on_locked(id, acc(who));
}

#[test]
fn conviction_grows_with_support_and_queues_when_enough() {
    let (mut chain, mut o) = orbit(conviction(), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    assert_eq!(o.get_proposal(id).unwrap().required_conviction.0, 150, "100 + 50 for 1 NEAR");
    support(&chain, &mut o, id, "alice.testnet", 1_000);
    chain.now += 100 * SEC;
    chain.call("viewer.testnet");
    assert_eq!(o.get_proposal(id).unwrap().conviction.0, 100);
    chain.call("anyone.testnet");
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.queue(id))).is_err());
    chain.now += 60 * SEC;
    chain.call("anyone.testnet");
    o.queue(id);
    assert_eq!(state(&chain, &o, id), State::Queued);
}

#[test]
fn moving_support_releases_and_relocks() {
    let (chain, mut o) = orbit(conviction(), None);
    let a = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    let b = propose(&chain, &mut o, "alice.testnet", r#""Vote""#);
    support(&chain, &mut o, a, "alice.testnet", 500);
    chain.call("alice.testnet");
    let _ = o.support(b);
    let batch = &get_created_receipts()[0];
    assert_eq!(batch.actions.len(), 2, "unlock, then lock_available, in one batch");
    assert_eq!(o.get_proposal(a).unwrap().support.0, 0);
    chain.callback(Some("\"500\"".into()));
    o.on_locked(b, acc("alice.testnet"));
    assert_eq!(o.get_support(acc("alice.testnet")), Some((b, U128(500))));
}

#[test]
fn governance_actions_need_the_governance_bar() {
    let c = match conviction() {
        Model::Conviction(c) => c,
        _ => unreachable!(),
    };
    let swap = orbit_common::swap_kind(&acc("q.testnet"));
    assert_eq!(conviction::required_conviction(&c, &swap, &acc(TOKEN)), 10_000);
    assert_eq!(conviction::required_conviction(&c, &serde_json::json!("Vote"), &acc(TOKEN)), 100);
}

// --- Delegate ---

fn delegate_model() -> Model {
    Model::Delegate(DelegateRules {
        council: council_rules(),
        council_size: 2,
        term_length: U64(30 * 24 * HOUR),
        candidacy_threshold: U128(10),
        candidacy_period: U64(24 * HOUR),
        election_period: U64(24 * HOUR),
        recall_quorum_bps: 2_000,
        recall_approval_bps: 5_000,
        recall_period: U64(24 * HOUR),
    })
}

#[test]
fn council_proposes_and_votes_one_seat_one_vote() {
    let (mut chain, mut o) = orbit(delegate_model(), Some(vec!["c1.testnet", "c2.testnet"]));
    let id = propose(&chain, &mut o, "c1.testnet", TRANSFER);
    chain.now += SEC;
    chain.call("c1.testnet");
    let _ = o.vote(id, Choice::For);
    chain.call("c2.testnet");
    let _ = o.vote(id, Choice::For);
    chain.now += 25 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Succeeded);
}

#[test]
#[should_panic(expected = "ERR_NOT_COUNCIL_MEMBER")]
fn only_the_council_proposes() {
    let (chain, mut o) = orbit(delegate_model(), Some(vec!["c1.testnet"]));
    propose(&chain, &mut o, "alice.testnet", TRANSFER);
}

#[test]
fn elections_seat_the_top_candidates_and_recalls_remove() {
    let (mut chain, mut o) = orbit(delegate_model(), Some(vec!["c1.testnet"]));
    chain.now += 31 * 24 * HOUR;
    chain.call("anyone.testnet");
    let e = o.start_election();
    for (who, stake) in [("x.testnet", 20), ("y.testnet", 20), ("z.testnet", 20), ("poor.testnet", 1)] {
        chain.call(who);
        let _ = o.declare_candidacy(e);
        chain.callback(weights(stake, 100));
        o.on_candidate_stake(e, acc(who));
    }
    assert_eq!(o.get_election(e).unwrap().0.candidates.len(), 3, "poor.testnet is below the threshold");
    chain.now += 25 * HOUR;
    for (voter, stake, picks) in [("v1.testnet", 30, vec!["x.testnet", "z.testnet"]), ("v2.testnet", 10, vec!["y.testnet"])] {
        let picks: Vec<AccountId> = picks.into_iter().map(acc).collect();
        chain.call(voter);
        let _ = o.vote_in_election(e, picks.clone());
        chain.callback(weights(stake, 100));
        o.on_election_weight(e, acc(voter), picks);
    }
    chain.now += 25 * HOUR;
    chain.call("anyone.testnet");
    assert_eq!(o.finalize_election(e), vec![acc("x.testnet"), acc("z.testnet")]);

    chain.call("v1.testnet");
    let _ = o.initiate_recall(acc("z.testnet"));
    chain.callback(weights(30, 100));
    let r = o.on_recall_stake(acc("z.testnet"), acc("v1.testnet")).unwrap();
    chain.call("v1.testnet");
    let _ = o.vote_recall(r, Choice::For);
    chain.callback(weights(30, 100));
    o.on_recall_weight(r, acc("v1.testnet"), Choice::For);
    chain.now += 25 * HOUR;
    chain.call("anyone.testnet");
    assert!(o.finalize_recall(r));
    assert_eq!(o.get_council(), vec![acc("x.testnet")]);
}

#[test]
#[should_panic(expected = "ERR_TERM_NOT_OVER")]
fn no_election_mid_term() {
    let (chain, mut o) = orbit(delegate_model(), Some(vec!["c1.testnet"]));
    chain.call("anyone.testnet");
    o.start_election();
}

// --- Sortition ---

#[test]
fn sortition_draws_a_council_from_the_pool() {
    let model = Model::Sortition(SortitionRules { council: council_rules(), council_size: 3, term_length: U64(7 * 24 * HOUR), eligibility_threshold: U128(5) });
    let (mut chain, mut o) = orbit(model, Some(vec![]));
    let members = ["p1.testnet", "p2.testnet", "p3.testnet", "p4.testnet", "p5.testnet"];
    for who in members {
        chain.call(who);
        let _ = o.register_eligible();
        chain.callback(weights(10, 100));
        assert!(o.on_eligible_stake(acc(who)));
    }
    chain.call("p5.testnet");
    o.withdraw_eligibility();
    chain.now += 8 * 24 * HOUR;
    chain.call("anyone.testnet");
    let council = o.draw();
    assert_eq!(council.len(), 3);
    assert!(council.iter().all(|m| members[..4].contains(&m.as_str())));
    let mut unique = council.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 3);
}

// --- Sowellian ---

fn sowellian() -> Model {
    Model::Sowellian(SowellianRules {
        approval: VoteRules { voting_delay: U64(0), ..rules() },
        proposal_bond: U128(50),
        positions_window: U64(24 * HOUR),
        resolution_bond: U128(20),
        challenge_period: U64(24 * HOUR),
        challenge_bond: U128(30),
        adjudication_period: U64(24 * HOUR),
        adjudication_quorum_bps: 1_000,
        adjudication_threshold_bps: 5_000,
        max_oracle_staleness: U64(HOUR),
    })
}

fn token_in(chain: &Chain, o: &mut Contract, from: &str, amount: u128, msg: &str) -> U128 {
    chain.call(TOKEN);
    match o.ft_on_transfer(acc(from), U128(amount), msg.to_string()) {
        PromiseOrValue::Value(unused) => unused,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

/// Paid token transfers in the receipts just created, as (receiver, amount).
fn token_payouts() -> Vec<(String, String)> {
    get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id == acc(TOKEN))
        .filter_map(|r| match &r.actions[0] {
            near_sdk::mock::MockAction::FunctionCallWeight { args, .. } => {
                let a: Value = serde_json::from_slice(args).ok()?;
                Some((a["receiver_id"].as_str()?.to_string(), a["amount"].as_str()?.to_string()))
            }
            _ => None,
        })
        .collect()
}

/// A Sowellian proposal approved and executed on the core, with positions
/// yes.testnet 300 and no.testnet 100; the clock is at its measurement deadline.
fn executed_bet(criteria: sowellian::Criteria) -> (Chain, Contract, u64) {
    let (mut chain, mut o) = orbit(sowellian(), None);
    chain.pay("alice.testnet", NearToken::from_millinear(100));
    let id = o.propose_with_criteria("grow revenue".into(), TRANSFER.into(), criteria, U64(48 * HOUR));
    assert_eq!(state(&chain, &o, id), State::Pending, "awaiting the bond");
    assert_eq!(token_in(&chain, &mut o, "alice.testnet", 70, &format!(r#"{{"proposal_bond":{id}}}"#)), U128(20));
    chain.now += SEC;
    vote(&chain, &mut o, id, "alice.testnet", Choice::For, 60, 100);
    chain.now += 25 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Positions);
    token_in(&chain, &mut o, "yes.testnet", 300, &format!(r#"{{"position":{id},"side":"Yes"}}"#));
    token_in(&chain, &mut o, "no.testnet", 100, &format!(r#"{{"position":{id},"side":"No"}}"#));
    chain.now += 26 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Succeeded);
    chain.call("anyone.testnet");
    let _ = o.execute(id);
    chain.callback(Some("0".into()));
    let _ = o.on_added(id);
    chain.callback(Some(String::new()));
    o.on_approved(id);
    chain.now += 48 * HOUR;
    (chain, o, id)
}

#[test]
fn sowellian_human_track_pays_the_winners() {
    let (mut chain, mut o, id) = executed_bet(sowellian::Criteria::Human);
    token_in(&chain, &mut o, "resolver.testnet", 20, &format!(r#"{{"resolve":{id},"outcome":"Success"}}"#));
    chain.now += 25 * HOUR;
    chain.call("anyone.testnet");
    assert_eq!(o.finalize_resolution(id), sowellian::Outcome::Success);
    let payouts = token_payouts();
    assert!(payouts.contains(&("resolver.testnet".into(), "20".into())), "resolution bond back");
    assert!(payouts.contains(&("alice.testnet".into(), "50".into())), "proposal bond back");
    chain.call("yes.testnet");
    assert_eq!(o.claim_position(id), U128(400), "the whole pool");
    chain.call("no.testnet");
    assert_eq!(o.claim_position(id), U128(0));
}

#[test]
fn sowellian_dispute_is_adjudicated_and_bonds_follow_the_truth() {
    let (mut chain, mut o, id) = executed_bet(sowellian::Criteria::Human);
    token_in(&chain, &mut o, "resolver.testnet", 20, &format!(r#"{{"resolve":{id},"outcome":"Failure"}}"#));
    token_in(&chain, &mut o, "critic.testnet", 30, &format!(r#"{{"dispute":{id}}}"#));
    chain.call("v.testnet");
    let _ = o.adjudicate(id, sowellian::Outcome::Success);
    chain.callback(weights(40, 100));
    o.on_adjudication_weight(id, acc("v.testnet"), sowellian::Outcome::Success);
    chain.now += 25 * HOUR;
    chain.call("anyone.testnet");
    assert_eq!(o.finalize_adjudication(id), sowellian::Outcome::Success);
    let payouts = token_payouts();
    assert!(payouts.contains(&(DAO.into(), "20".into())), "the wrong resolver's bond goes to the treasury");
    assert!(payouts.contains(&("critic.testnet".into(), "30".into())), "the right challenger gets theirs back");
}

#[test]
fn sowellian_oracle_resolves_with_fresh_data_only() {
    let criteria = sowellian::Criteria::Oracle { oracle: acc("oracle.testnet"), selector: "near-usd".into(), target: near_sdk::json_types::I128(5), minimum: true };
    let (chain, mut o, id) = executed_bet(criteria);
    chain.call("anyone.testnet");
    let _ = o.resolve_via_oracle(id);
    let stale = chain.now - 2 * HOUR;
    chain.callback(Some(format!(r#"["7","{stale}"]"#)));
    assert_eq!(o.on_oracle_value(id), None, "stale");
    chain.callback(Some(format!(r#"["7","{}"]"#, chain.now)));
    assert_eq!(o.on_oracle_value(id), Some(sowellian::Outcome::Success));
}

#[test]
fn sowellian_rejected_approval_forfeits_the_bond() {
    let (mut chain, mut o) = orbit(sowellian(), None);
    chain.pay("alice.testnet", NearToken::from_millinear(100));
    let id = o.propose_with_criteria("x".into(), TRANSFER.into(), sowellian::Criteria::Human, U64(HOUR));
    token_in(&chain, &mut o, "alice.testnet", 50, &format!(r#"{{"proposal_bond":{id}}}"#));
    chain.now += SEC;
    vote(&chain, &mut o, id, "a.testnet", Choice::Against, 60, 100);
    chain.now += 25 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Defeated);
    chain.call("anyone.testnet");
    o.forfeit_bond(id);
    assert_eq!(token_payouts(), vec![(DAO.to_string(), "50".to_string())]);
}

#[test]
#[should_panic(expected = "ERR_USE_PROPOSE_WITH_CRITERIA")]
fn sowellian_needs_criteria() {
    let (chain, mut o) = orbit(sowellian(), None);
    propose(&chain, &mut o, "alice.testnet", TRANSFER);
}

// --- Decision markets ---

fn decision() -> Model {
    Model::DecisionMarkets(DecisionRules { trading_period: U64(24 * HOUR), threshold_bps: 100, timelock: U64(0), execution_period: U64(48 * HOUR) })
}

fn opened_market() -> (Chain, Contract, u64) {
    let (chain, mut o) = orbit(decision(), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    assert_eq!(state(&chain, &o, id), State::Pending);
    chain.pay("alice.testnet", NearToken::from_yoctonear(1_000_000));
    o.seed_near(id);
    token_in(&chain, &mut o, "alice.testnet", 1_000_000, &format!(r#"{{"seed":{id}}}"#));
    assert_eq!(state(&chain, &o, id), State::Active);
    (chain, o, id)
}

#[test]
fn uniswap_pricing() {
    assert_eq!(markets::amount_out(1_000, 1_000_000, 1_000_000), 996);
    assert_eq!(markets::amount_out(0, 10, 10), 0);
}

#[test]
fn decision_market_follows_the_pass_price() {
    let (mut chain, mut o, id) = opened_market();
    // A trader who expects the proposal to help buys tokens in the pass market.
    chain.pay("bull.testnet", NearToken::from_yoctonear(500_000));
    o.split_near(id);
    chain.call("bull.testnet");
    let bought = o.trade(id, markets::Side::Pass, markets::Asset::Near, U128(500_000), U128(1));
    assert!(bought.0 > 0);
    chain.now += 25 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Succeeded, "pass priced the token higher");
    let (_, pass, fail) = o.get_exchange(id).unwrap();
    assert!(pass.0 > fail.0);

    chain.call("bull.testnet");
    let (token, near) = o.redeem(id);
    assert_eq!((token, near), (bought, U128(0)), "winning pass units pay out; fail NEAR units are worthless");
    chain.call("anyone.testnet");
    let (seed_token, seed_near) = o.reclaim_liquidity(id);
    assert_eq!(seed_token.0 + bought.0, 1_000_000, "the pass pool's tokens, less what the bull bought");
    assert_eq!(seed_near.0, 1_500_000);
}

#[test]
fn an_untraded_decision_market_fails() {
    let (mut chain, o, id) = opened_market();
    chain.now += 25 * HOUR;
    assert_eq!(state(&chain, &o, id), State::Defeated, "equal prices don't beat the threshold");
}

#[test]
#[should_panic(expected = "ERR_TRADING_CLOSED")]
fn no_trading_after_the_window() {
    let (mut chain, mut o, id) = opened_market();
    chain.now += 25 * HOUR;
    chain.call("bull.testnet");
    o.trade(id, markets::Side::Pass, markets::Asset::Near, U128(1), U128(0));
}

#[test]
fn cancelling_before_the_markets_open_returns_the_seed() {
    let (chain, mut o) = orbit(decision(), None);
    let id = propose(&chain, &mut o, "alice.testnet", TRANSFER);
    chain.pay("alice.testnet", NearToken::from_yoctonear(5_000));
    o.seed_near(id);
    chain.call("alice.testnet");
    o.cancel(id);
    let refund = get_created_receipts().into_iter().find(|r| r.receiver_id == acc("alice.testnet")).expect("refund");
    assert!(matches!(refund.actions[0], near_sdk::mock::MockAction::Transfer { deposit, .. } if deposit == NearToken::from_yoctonear(5_000)));
}
