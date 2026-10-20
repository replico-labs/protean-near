use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

use super::*;

const DAO: &str = "mydao.sputnikv2.testnet";
const ORBIT: &str = "tw.mydao.orbits.testnet";
const STAKING: &str = "staking.mydao.orbits.testnet";
const TOKEN: &str = "token.mydao.orbits.testnet";
const HOUR: u64 = 3_600_000_000_000;
const TRANSFER: &str =
    r#"{"Transfer":{"token_id":"","receiver_id":"maya.testnet","amount":"1000000000000000000000000"}}"#;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

struct Env {
    time: u64,
}

impl Env {
    fn call(&self, who: &str, deposit: NearToken) {
        self.call_with(who, deposit, Gas::from_tgas(300), vec![]);
    }

    fn call_with(&self, who: &str, deposit: NearToken, gas: Gas, results: Vec<PromiseResult>) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acc(ORBIT))
            .predecessor_account_id(acc(who))
            .attached_deposit(deposit)
            .prepaid_gas(gas)
            .account_balance(NearToken::from_near(5))
            .block_timestamp(self.time);
        testing_env!(ctx.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }
}

fn config() -> Config {
    Config {
        threshold: (1, 2),
        quorum: U128(0),
        voting_period: U64(24 * HOUR),
        min_proposer_weight: U128(0),
    }
}

/// An orbit with three stakers: alice 50, bob 30, carol 20 (total 100).
fn setup() -> (Env, Contract) {
    let env = Env { time: 1_000 * HOUR };
    env.call(DAO, NearToken::from_near(0));
    let mut orbit = Contract::new(acc(DAO), acc(STAKING), acc(TOKEN), config());
    for (who, amount) in [("alice.testnet", 50), ("bob.testnet", 30), ("carol.testnet", 20)] {
        env.call(STAKING, env::storage_byte_cost().saturating_mul(16));
        orbit.register_delegation(acc(who));
        env.call(STAKING, NearToken::from_near(0));
        orbit.delegate(acc(who), U128(amount));
    }
    (env, orbit)
}

fn propose(env: &Env, orbit: &mut Contract, kind: &str) -> u64 {
    env.call("alice.testnet", NearToken::from_millinear(100));
    orbit.propose("pay maya".into(), kind.into())
}

#[test]
fn delegation_tracks_weight_and_total() {
    let (env, mut orbit) = setup();
    assert_eq!(orbit.delegation_balance_of(acc("alice.testnet")).0, 50);
    assert_eq!(orbit.delegation_total_supply().0, 100);
    env.call(STAKING, NearToken::from_near(0));
    let (prev, new, total) = orbit.undelegate(acc("alice.testnet"), U128(20));
    assert_eq!((prev.0, new.0, total.0), (50, 30, 80));
}

#[test]
#[should_panic(expected = "ERR_INVALID_CALLER")]
fn only_staking_contract_may_delegate() {
    let (env, mut orbit) = setup();
    env.call("alice.testnet", NearToken::from_near(0));
    orbit.delegate(acc("alice.testnet"), U128(1_000));
}

#[test]
fn re_registering_keeps_weight() {
    let (env, mut orbit) = setup();
    env.call(STAKING, env::storage_byte_cost().saturating_mul(16));
    orbit.register_delegation(acc("alice.testnet"));
    assert_eq!(orbit.delegation_balance_of(acc("alice.testnet")).0, 50);
}

#[test]
fn threshold_is_more_than_half_of_total() {
    let (_, orbit) = setup();
    assert_eq!(orbit.get_threshold().0, 51);
}

#[test]
fn threshold_handles_huge_supply() {
    let (env, mut orbit) = setup();
    env.call(STAKING, NearToken::from_near(0));
    // A billion tokens with 24 decimals, plus the 100 already staked.
    orbit.delegate(acc("alice.testnet"), U128(10u128.pow(33)));
    assert_eq!(orbit.get_threshold().0, (10u128.pow(33) + 100) / 2 + 1);
}

#[test]
fn threshold_is_at_least_one_with_no_stake() {
    let env = Env { time: 0 };
    env.call(DAO, NearToken::from_near(0));
    let orbit = Contract::new(acc(DAO), acc(STAKING), acc(TOKEN), config());
    assert_eq!(orbit.get_threshold().0, 1);
}

#[test]
#[should_panic(expected = "ERR_KIND_LOCKS_CORE")]
fn propose_refuses_kinds_that_lock_the_core() {
    let (env, mut orbit) = setup();
    propose(&env, &mut orbit, r#"{"ChangePolicyRemoveRole":{"role":"governance"}}"#);
}

#[test]
#[should_panic(expected = "ERR_DEPOSIT")]
fn propose_needs_storage_deposit() {
    let (env, mut orbit) = setup();
    env.call("alice.testnet", NearToken::from_near(0));
    orbit.propose("pay maya".into(), TRANSFER.into());
}

#[test]
fn propose_refunds_extra_deposit() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    assert_eq!(id, 0);
    assert_eq!(get_created_receipts().len(), 1, "refund of the unused deposit");
    let view = orbit.get_proposal(0).unwrap();
    assert_eq!(view.status, Status::InProgress);
    assert_eq!(view.kind["Transfer"]["receiver_id"], "maya.testnet");
}

#[test]
#[should_panic(expected = "ERR_NOT_ENOUGH_WEIGHT_TO_PROPOSE")]
fn min_proposer_weight_is_enforced() {
    let env = Env { time: 0 };
    env.call(DAO, NearToken::from_near(0));
    let mut orbit = Contract::new(acc(DAO), acc(STAKING), acc(TOKEN), Config { min_proposer_weight: U128(10), ..config() });
    propose(&env, &mut orbit, TRANSFER);
}

#[test]
fn majority_passes_and_starts_sending() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    env.call("alice.testnet", NearToken::from_near(0));
    assert_eq!(orbit.vote(id, Choice::Approve), Status::InProgress, "50 of 100 is not more than half");
    env.call("carol.testnet", NearToken::from_near(0));
    assert_eq!(orbit.vote(id, Choice::Approve), Status::Passed);
    let view = orbit.get_proposal(id).unwrap();
    assert_eq!(view.approve.0, 70);
    assert!(view.sending, "enough gas was attached, so the send started");
    assert_eq!(get_created_receipts().len(), 2, "add_proposal on the core, then on_added");
}

#[test]
fn pass_with_little_gas_waits_for_execute() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    env.call("alice.testnet", NearToken::from_near(0));
    orbit.vote(id, Choice::Approve);
    env.call_with("bob.testnet", NearToken::from_near(0), Gas::from_tgas(30), vec![]);
    assert_eq!(orbit.vote(id, Choice::Approve), Status::Passed);
    assert!(!orbit.get_proposal(id).unwrap().sending);

    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
    assert!(orbit.get_proposal(id).unwrap().sending);
}

#[test]
fn majority_rejects() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    for who in ["alice.testnet", "bob.testnet"] {
        env.call(who, NearToken::from_near(0));
        orbit.vote(id, Choice::Reject);
    }
    assert_eq!(orbit.get_proposal(id).unwrap().status, Status::Rejected);
}

#[test]
#[should_panic(expected = "ERR_ALREADY_VOTED")]
fn cannot_vote_twice() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    env.call("carol.testnet", NearToken::from_near(0));
    orbit.vote(id, Choice::Approve);
    orbit.vote(id, Choice::Approve);
}

#[test]
#[should_panic(expected = "ERR_NO_WEIGHT")]
fn cannot_vote_without_weight() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    env.call("dave.testnet", NearToken::from_near(0));
    orbit.vote(id, Choice::Approve);
}

#[test]
fn voting_after_the_period_expires_the_proposal() {
    let (mut env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    env.time += 25 * HOUR;
    env.call("alice.testnet", NearToken::from_near(0));
    assert_eq!(orbit.vote(id, Choice::Approve), Status::Expired);
    assert_eq!(orbit.get_proposal(id).unwrap().status, Status::Expired);
}

#[test]
fn finalize_expires_after_the_period_only() {
    let (mut env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    env.time += 25 * HOUR;
    env.call("anyone.testnet", NearToken::from_near(0));
    assert_eq!(orbit.finalize(id), Status::Expired);
}

#[test]
#[should_panic(expected = "ERR_VOTING_NOT_OVER")]
fn finalize_refuses_open_proposal() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    orbit.finalize(id);
}

/// Passes proposal `id` with enough weight but too little gas to send.
fn pass(env: &Env, orbit: &mut Contract, id: u64) {
    for who in ["alice.testnet", "bob.testnet"] {
        env.call_with(who, NearToken::from_near(0), Gas::from_tgas(30), vec![]);
        orbit.vote(id, Choice::Approve);
    }
    assert_eq!(orbit.get_proposal(id).unwrap().status, Status::Passed);
}

#[test]
#[should_panic(expected = "ERR_ALREADY_SENDING")]
fn only_one_send_at_a_time() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    pass(&env, &mut orbit, id);
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
    let _ = orbit.execute(id);
}

#[test]
fn stuck_send_can_be_retried_after_timeout() {
    let (mut env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    pass(&env, &mut orbit, id);
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
    env.time += SEND_TIMEOUT_NS + 1;
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
}

#[test]
fn successful_send_records_core_id_then_executes() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    pass(&env, &mut orbit, id);
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);

    env.call_with(ORBIT, NearToken::from_near(0), Gas::from_tgas(200), vec![PromiseResult::Successful(b"7".to_vec())]);
    let _ = orbit.on_added(id);
    assert_eq!(orbit.get_proposal(id).unwrap().core_proposal_id, Some(7));

    env.call_with(ORBIT, NearToken::from_near(0), Gas::from_tgas(20), vec![PromiseResult::Successful(vec![])]);
    orbit.on_approved(id);
    let view = orbit.get_proposal(id).unwrap();
    assert_eq!(view.status, Status::Executed);
    assert!(!view.sending);
}

#[test]
fn failed_add_frees_the_proposal_for_retry() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    pass(&env, &mut orbit, id);
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
    env.call_with(ORBIT, NearToken::from_near(0), Gas::from_tgas(200), vec![PromiseResult::Failed]);
    let _ = orbit.on_added(id);
    let view = orbit.get_proposal(id).unwrap();
    assert_eq!((view.status, view.sending, view.core_proposal_id), (Status::Passed, false, None));
}

#[test]
fn failed_approval_keeps_core_id_for_retry() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, TRANSFER);
    pass(&env, &mut orbit, id);
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
    env.call_with(ORBIT, NearToken::from_near(0), Gas::from_tgas(200), vec![PromiseResult::Successful(b"3".to_vec())]);
    let _ = orbit.on_added(id);
    env.call_with(ORBIT, NearToken::from_near(0), Gas::from_tgas(20), vec![PromiseResult::Failed]);
    orbit.on_approved(id);
    let view = orbit.get_proposal(id).unwrap();
    assert_eq!((view.status, view.sending, view.core_proposal_id), (Status::Passed, false, Some(3)));

    // A retry goes straight to approval: one act_proposal plus its callback.
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
    assert_eq!(get_created_receipts().len(), 2);
}

fn swap_to(new_orbit: &str) -> String {
    orbit_common::swap_kind(&acc(new_orbit)).to_string()
}

#[test]
fn swap_is_sent_only_to_an_orbit_bound_to_this_core() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, &swap_to("q.mydao.orbits.testnet"));
    pass(&env, &mut orbit, id);
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);

    // The new orbit answers with a different core: nothing is sent.
    let other = br#""other.sputnikv2.testnet""#.to_vec();
    env.call_with(ORBIT, NearToken::from_near(0), Gas::from_tgas(200), vec![PromiseResult::Successful(other)]);
    let _ = orbit.on_swap_checked(id);
    assert!(get_logs()[0].contains("not sent"));
    assert!(!orbit.get_proposal(id).unwrap().sending);

    // Once it's bound to this core, the swap goes ahead.
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
    let ours = format!("\"{DAO}\"").into_bytes();
    env.call_with(ORBIT, NearToken::from_near(0), Gas::from_tgas(200), vec![PromiseResult::Successful(ours)]);
    let _ = orbit.on_swap_checked(id);
    assert!(orbit.get_proposal(id).unwrap().sending);
    assert_eq!(get_created_receipts().len(), 2, "add_proposal on the core, then on_added");
}

#[test]
fn swap_check_survives_garbage_answer() {
    let (env, mut orbit) = setup();
    let id = propose(&env, &mut orbit, &swap_to("q.mydao.orbits.testnet"));
    pass(&env, &mut orbit, id);
    env.call("anyone.testnet", NearToken::from_near(0));
    let _ = orbit.execute(id);
    env.call_with(ORBIT, NearToken::from_near(0), Gas::from_tgas(200), vec![PromiseResult::Successful(b"{".to_vec())]);
    let _ = orbit.on_swap_checked(id);
    assert!(!orbit.get_proposal(id).unwrap().sending);
}

#[test]
fn views_list_proposals() {
    let (env, mut orbit) = setup();
    for _ in 0..3 {
        propose(&env, &mut orbit, TRANSFER);
    }
    assert_eq!(orbit.get_proposal_count(), 3);
    assert_eq!((orbit.get_dao(), orbit.get_token()), (acc(DAO), acc(TOKEN)));
    assert_eq!(orbit.get_proposals(1, 10).iter().map(|p| p.id).collect::<Vec<_>>(), vec![1, 2]);
    env.call("bob.testnet", NearToken::from_near(0));
    orbit.vote(2, Choice::Reject);
    assert_eq!(orbit.get_vote(2, acc("bob.testnet")), Some(Choice::Reject));
    assert_eq!(orbit.get_vote(2, acc("alice.testnet")), None);
}
