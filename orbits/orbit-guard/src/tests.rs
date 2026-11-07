use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

use super::*;

const DAO: &str = "ark.sputnik.protean.testnet";
const GUARD: &str = "guard.ark.protean.testnet";
const ORBIT: &str = "tw.ark.protean.testnet";
const SEC: u64 = 1_000_000_000;
const DAY: u64 = 86_400 * SEC;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

struct Chain {
    now: u64,
}

impl Chain {
    fn call_with(&self, who: &str, results: Vec<PromiseResult>) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acc(GUARD))
            .predecessor_account_id(acc(who))
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(5))
            .block_timestamp(self.now);
        testing_env!(ctx.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }

    fn call(&self, who: &str) {
        self.call_with(who, vec![]);
    }

    fn callback(&self, json: &str) {
        self.call_with(GUARD, vec![PromiseResult::Successful(json.as_bytes().to_vec())]);
    }
}

fn guard() -> (Chain, Contract) {
    let chain = Chain { now: 100 * DAY };
    chain.call("deployer.testnet");
    let signers = vec![acc("s1.testnet"), acc("s2.testnet"), acc("s3.testnet")];
    (chain, Contract::new(acc(DAO), acc(ORBIT), signers, 2, U64(30 * DAY), U64(7 * DAY)))
}

fn transfer() -> Value {
    json!({ "Transfer": { "token_id": "", "receiver_id": "maya.testnet", "amount": "1000" } })
}

fn instruct(chain: &Chain, g: &mut Contract, kind: Value) -> u64 {
    chain.call(ORBIT);
    g.propose_instruction("pay maya".into(), kind)
}

fn methods() -> Vec<String> {
    get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } => Some(String::from_utf8(method_name.clone()).unwrap()),
            _ => None,
        })
        .collect()
}

#[test]
fn only_governance_sends_instructions() {
    let (chain, mut g) = guard();
    chain.call("s1.testnet");
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.propose_instruction("x".into(), transfer()))).is_err());
    let id = instruct(&chain, &mut g, transfer());
    assert_eq!(g.get_instruction(id).unwrap().state, InstructionState::Pending);
}

#[test]
#[should_panic(expected = "ERR_KIND_LOCKS_CORE")]
fn proposals_that_lock_the_core_are_refused() {
    let (chain, mut g) = guard();
    instruct(&chain, &mut g, json!({ "ChangePolicy": { "policy": [] } }));
}

#[test]
fn the_threshold_sends_it_to_the_core_and_approves_it() {
    let (chain, mut g) = guard();
    let id = instruct(&chain, &mut g, transfer());
    chain.call("s1.testnet");
    assert!(matches!(g.confirm(id), PromiseOrValue::Value(InstructionState::Pending)));
    chain.call("s1.testnet");
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.confirm(id))).is_err(), "once each");
    chain.call("stranger.testnet");
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.confirm(id))).is_err(), "signers only");

    chain.call("s2.testnet");
    assert!(matches!(g.confirm(id), PromiseOrValue::Promise(_)));
    assert!(methods().contains(&"add_proposal".to_string()));
    chain.callback("9");
    let _ = g.on_added(id);
    assert!(methods().contains(&"act_proposal".to_string()));
    chain.callback("");
    assert!(g.on_approved(id));
    let view = g.get_instruction(id).unwrap();
    assert_eq!((view.state, view.core_proposal_id), (InstructionState::Executed, Some(9)));
}

#[test]
fn a_failed_approval_can_be_resent() {
    let (chain, mut g) = guard();
    let id = instruct(&chain, &mut g, transfer());
    for s in ["s1.testnet", "s2.testnet"] {
        chain.call(s);
        let _ = g.confirm(id);
    }
    chain.callback("9");
    let _ = g.on_added(id);
    chain.call_with(GUARD, vec![PromiseResult::Failed]);
    assert!(!g.on_approved(id));
    assert_eq!(g.get_instruction(id).unwrap().state, InstructionState::Confirmed);
    chain.call("anyone.testnet");
    let _ = g.send(id);
    assert_eq!(methods(), vec!["act_proposal".to_string(), "on_approved".to_string()], "approves the same core proposal");
}

#[test]
fn enough_rejections_kill_it_and_votes_can_be_revoked() {
    let (chain, mut g) = guard();
    let id = instruct(&chain, &mut g, transfer());
    chain.call("s1.testnet");
    g.reject(id);
    chain.call("s1.testnet");
    g.revoke(id);
    assert_eq!(g.get_instruction(id).unwrap().rejections, 0);
    chain.call("s1.testnet");
    assert_eq!(g.reject(id), InstructionState::Pending, "2 of 3 can still confirm");
    chain.call("s2.testnet");
    assert_eq!(g.reject(id), InstructionState::Rejected);
}

#[test]
fn unconfirmed_instructions_expire() {
    let (mut chain, mut g) = guard();
    let id = instruct(&chain, &mut g, transfer());
    chain.now += 8 * DAY;
    chain.call("s1.testnet");
    assert_eq!(g.get_instruction(id).unwrap().state, InstructionState::Expired);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.confirm(id))).is_err());
}

#[test]
fn governance_replaces_signers_only_after_the_tenure() {
    let (mut chain, mut g) = guard();
    let kind = set_signers_kind(&acc(GUARD), &[acc("n1.testnet"), acc("n2.testnet")], 2);
    chain.call(ORBIT);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.propose_instruction("new signers".into(), kind.clone())));
    assert!(early.is_err(), "the tenure isn't over");
    chain.now += 31 * DAY;
    let id = instruct(&chain, &mut g, kind);
    let config = g.get_config();
    assert_eq!((config.signers, config.threshold), (vec![acc("n1.testnet"), acc("n2.testnet")], 2));
    assert_eq!(config.tenure_end.0, chain.now + 30 * DAY, "a new tenure starts");
    assert_eq!(g.get_instruction(id).unwrap().state, InstructionState::Executed, "no signer confirmed it");
}

#[test]
fn only_the_core_moves_governance_and_only_to_a_bound_orbit() {
    let (chain, mut g) = guard();
    chain.call(ORBIT);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.set_governance(acc("q.testnet")))).is_err());
    chain.call(DAO);
    let _ = g.set_governance(acc("q.testnet"));
    chain.callback(&format!(r#"{{"dao_id":"other.testnet","staking_id":"s.testnet","token_id":"t.testnet","governance":null}}"#));
    assert!(matches!(g.on_new_binding(acc("q.testnet")), PromiseOrValue::Value(false)));
    assert!(get_logs()[0].contains("isn't an orbit bound"));

    chain.callback(&format!(r#"{{"dao_id":"{DAO}","staking_id":"s.testnet","token_id":"t.testnet","governance":null}}"#));
    assert!(matches!(g.on_new_binding(acc("q.testnet")), PromiseOrValue::Promise(_)));
    let answers = |dao: &str| vec![PromiseResult::Successful(format!("\"{dao}\"").into_bytes()), PromiseResult::Successful(br#""t.testnet""#.to_vec())];
    chain.call_with(GUARD, answers("other.testnet"));
    assert!(!g.on_new_vault(acc("q.testnet"), acc("t.testnet")));
    chain.call_with(GUARD, answers(DAO));
    assert!(g.on_new_vault(acc("q.testnet"), acc("t.testnet")));
    assert_eq!(g.get_governance(), acc("q.testnet"));
    assert_eq!(g.get_binding().governance, Some(acc("q.testnet")));
}

#[test]
#[should_panic(expected = "ERR_CONFIG: threshold")]
fn the_threshold_fits_the_signers() {
    let chain = Chain { now: 0 };
    chain.call("deployer.testnet");
    Contract::new(acc(DAO), acc(ORBIT), vec![acc("s1.testnet")], 2, U64(DAY), U64(DAY));
}
