use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

use super::*;

const DAO: &str = "mydao.sputnikv2.testnet";
const TOKEN: &str = "token.mydao.orbits.testnet";
const ORBIT: &str = "tw.mydao.orbits.testnet";
const SEC: u64 = 1_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn call(who: &str, time: u64, deposit: NearToken, results: Vec<PromiseResult>) {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(acc("staking.mydao.orbits.testnet"))
        .predecessor_account_id(acc(who))
        .attached_deposit(deposit)
        .block_timestamp(time)
        .account_balance(NearToken::from_near(5));
    testing_env!(ctx.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn at(who: &str, time: u64) {
    call(who, time, NearToken::from_near(0), vec![]);
}

fn setup() -> Contract {
    at(DAO, 0);
    let mut staking = Contract::new(acc(DAO), acc(TOKEN));
    for who in ["alice.testnet", "bob.testnet"] {
        call(who, 0, MIN_STORAGE_DEPOSIT, vec![]);
        staking.storage_deposit(None);
    }
    staking
}

fn stake(staking: &mut Contract, who: &str, amount: u128, time: u64) {
    at(TOKEN, time);
    let _ = staking.ft_on_transfer(acc(who), U128(amount), String::new());
}

#[test]
fn snapshots_count_stake_strictly_before() {
    let mut staking = setup();
    stake(&mut staking, "alice.testnet", 100, 10 * SEC);
    stake(&mut staking, "bob.testnet", 50, 20 * SEC);
    stake(&mut staking, "alice.testnet", 25, 30 * SEC);
    let w = |t| {
        let (own, total) = staking.weights_at(acc("alice.testnet"), U64(t));
        (own.0, total.0)
    };
    assert_eq!(w(10 * SEC), (0, 0), "a snapshot at the staking moment doesn't count it");
    assert_eq!(w(10 * SEC + 1), (100, 100));
    assert_eq!(w(25 * SEC), (100, 150));
    assert_eq!(w(31 * SEC), (125, 175));
}

#[test]
fn unstake_returns_tokens_and_snapshots_keep_old_weight() {
    let mut staking = setup();
    stake(&mut staking, "alice.testnet", 100, 10 * SEC);
    call("alice.testnet", 20 * SEC, NearToken::from_yoctonear(1), vec![]);
    let _ = staking.unstake(U128(40));
    assert_eq!(get_created_receipts().len(), 2, "ft_transfer, then on_unstaked");
    assert_eq!(staking.get_member(acc("alice.testnet")).unwrap().stake.0, 60);
    assert_eq!(staking.weights_at(acc("alice.testnet"), U64(15 * SEC)).0.0, 100);
    assert_eq!(staking.weights_at(acc("alice.testnet"), U64(21 * SEC)).0.0, 60);
}

#[test]
fn failed_return_is_restaked() {
    let mut staking = setup();
    stake(&mut staking, "alice.testnet", 100, 10 * SEC);
    call("alice.testnet", 20 * SEC, NearToken::from_yoctonear(1), vec![]);
    let _ = staking.unstake(U128(40));
    call("staking.mydao.orbits.testnet", 21 * SEC, NearToken::from_near(0), vec![PromiseResult::Failed]);
    staking.on_unstaked(acc("alice.testnet"), U128(40));
    assert_eq!(staking.get_member(acc("alice.testnet")).unwrap().stake.0, 100);
}

#[test]
#[should_panic(expected = "ERR_NOT_REGISTERED")]
fn staking_needs_registration() {
    let mut staking = setup();
    stake(&mut staking, "carol.testnet", 100, SEC);
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn only_the_dao_token_stakes() {
    let mut staking = setup();
    at("fake-token.testnet", SEC);
    let _ = staking.ft_on_transfer(acc("alice.testnet"), U128(100), String::new());
}

#[test]
fn storage_is_paid_from_the_member_balance() {
    let mut staking = setup();
    let before = staking.get_member(acc("alice.testnet")).unwrap().storage_balance;
    stake(&mut staking, "alice.testnet", 100, SEC);
    let after = staking.get_member(acc("alice.testnet")).unwrap().storage_balance;
    assert!(after < before);
    // A second change in the same block reuses the checkpoint.
    stake(&mut staking, "alice.testnet", 1, SEC);
    assert_eq!(staking.get_member(acc("alice.testnet")).unwrap().storage_balance, after);
}

fn policy(members: &[&str]) -> Vec<u8> {
    serde_json::json!({ "roles": [{ "name": "governance", "kind": { "Group": members }, "permissions": [], "vote_policy": {} }] })
        .to_string()
        .into_bytes()
}

fn claim(staking: &mut Contract, claimant: &str, members: &[&str]) -> bool {
    call("staking.mydao.orbits.testnet", SEC, NearToken::from_near(0), vec![PromiseResult::Successful(policy(members))]);
    staking.on_policy(acc(claimant))
}

#[test]
fn only_the_governing_orbit_becomes_locker() {
    let mut staking = setup();
    assert!(!claim(&mut staking, "stranger.testnet", &[ORBIT]));
    assert_eq!(staking.get_locker(), None);
    assert!(claim(&mut staking, ORBIT, &[ORBIT]));
    assert_eq!(staking.get_locker(), Some(acc(ORBIT)));
}

#[test]
fn locks_block_unstaking_and_survive_a_locker_change() {
    let mut staking = setup();
    stake(&mut staking, "alice.testnet", 100, SEC);
    claim(&mut staking, ORBIT, &[ORBIT]);
    at(ORBIT, 2 * SEC);
    assert_eq!(staking.lock_available(acc("alice.testnet")).0, 100);
    assert_eq!(staking.get_member(acc("alice.testnet")).unwrap().available.0, 0);

    // A new orbit takes over; the old one can still release what it locked.
    claim(&mut staking, "new.mydao.orbits.testnet", &["new.mydao.orbits.testnet"]);
    at(ORBIT, 3 * SEC);
    staking.unlock(acc("alice.testnet"), U128(100));
    assert_eq!(staking.get_member(acc("alice.testnet")).unwrap().available.0, 100);
}

#[test]
#[should_panic(expected = "ERR_NOT_ENOUGH_UNLOCKED_STAKE")]
fn locked_stake_cannot_be_unstaked() {
    let mut staking = setup();
    stake(&mut staking, "alice.testnet", 100, SEC);
    claim(&mut staking, ORBIT, &[ORBIT]);
    at(ORBIT, 2 * SEC);
    staking.lock_available(acc("alice.testnet"));
    call("alice.testnet", 3 * SEC, NearToken::from_yoctonear(1), vec![]);
    let _ = staking.unstake(U128(1));
}

#[test]
#[should_panic(expected = "ERR_NOT_LOCKER")]
fn only_the_locker_locks() {
    let mut staking = setup();
    stake(&mut staking, "alice.testnet", 100, SEC);
    at("stranger.testnet", 2 * SEC);
    staking.lock_available(acc("alice.testnet"));
}

#[test]
#[should_panic(expected = "ERR_NOT_DAO")]
fn only_the_dao_sets_the_locker() {
    let mut staking = setup();
    at(ORBIT, SEC);
    staking.set_locker(Some(acc(ORBIT)));
}
