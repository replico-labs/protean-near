//! Checks the Orbits core design against the real, unmodified Sputnik DAO
//! contract: a DAO whose only member is one orbit account, with a 1-of-1
//! threshold and no proposal bond (see docs/SPEC.md).
#[cfg(test)]
mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, AccountId, NearToken};
    use sputnikdao2::*;

    const POLICY: &str = r#"{
      "roles": [{
        "name": "governance",
        "kind": { "Group": ["orbit1.testnet"] },
        "permissions": ["*:AddProposal","*:VoteApprove","*:VoteReject","*:VoteRemove","*:Finalize"],
        "vote_policy": {}
      }],
      "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1] },
      "proposal_bond": "0",
      "proposal_period": "604800000000000",
      "bounty_bond": "0",
      "bounty_forgiveness_period": "86400000000000"
    }"#;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }

    fn as_caller(who: &str) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acc("mydao.sputnikv2.testnet"))
            .predecessor_account_id(acc(who))
            .account_balance(NearToken::from_near(10))
            .attached_deposit(NearToken::from_near(0));
        testing_env!(ctx.build());
    }

    fn new_dao() -> Contract {
        as_caller("sputnikv2.testnet");
        let policy: VersionedPolicy = serde_json::from_str(POLICY).expect("policy JSON must parse");
        let generated: VersionedPolicy =
            serde_json::from_str(&orbit_common::core_policy(&acc("orbit1.testnet")).to_string()).unwrap();
        assert_eq!(generated, policy, "orbit_common::core_policy matches the documented policy");
        let config: Config = serde_json::from_str(r#"{"name":"mydao","purpose":"test","metadata":""}"#).unwrap();
        Contract::new(config, policy)
    }

    /// Makes the same two calls an orbit makes, from the argument bytes
    /// orbit_common builds, decoded with Sputnik's own types.
    fn propose_and_approve(dao: &mut Contract, orbit: &str, kind: ProposalKind) -> u64 {
        let kind = serde_json::to_value(&kind).unwrap();
        assert!(orbit_common::classify(&kind).is_ok(), "orbit would refuse {kind}");
        as_caller(orbit);
        let args: serde_json::Value =
            serde_json::from_slice(&orbit_common::add_proposal_args("orbit-passed", &kind)).unwrap();
        let input: ProposalInput = serde_json::from_value(args["proposal"].clone()).unwrap();
        let id = dao.add_proposal(input);
        let args: serde_json::Value = serde_json::from_slice(&orbit_common::act_proposal_args(id, &kind)).unwrap();
        let action: Action = serde_json::from_value(args["action"].clone()).unwrap();
        let proposal: ProposalKind = serde_json::from_value(args["proposal"].clone()).unwrap();
        dao.act_proposal(args["id"].as_u64().unwrap(), action, proposal, None);
        id
    }

    #[test]
    fn single_orbit_vote_executes_immediately() {
        let mut dao = new_dao();
        let id = propose_and_approve(&mut dao, "orbit1.testnet", ProposalKind::Transfer {
            token_id: String::new(),
            receiver_id: acc("maya.testnet"),
            amount: near_sdk::json_types::U128(NearToken::from_near(1).as_yoctonear()),
            msg: None,
        });
        assert_eq!(dao.get_proposal(id).proposal.status, ProposalStatus::Approved);
    }

    #[test]
    #[should_panic(expected = "ERR_PERMISSION_DENIED")]
    fn outsider_cannot_add_proposal() {
        let mut dao = new_dao();
        as_caller("maya.testnet");
        dao.add_proposal(ProposalInput { description: "spam".into(), kind: ProposalKind::Vote });
    }

    #[test]
    #[should_panic(expected = "ERR_PERMISSION_DENIED")]
    fn outsider_cannot_vote() {
        let mut dao = new_dao();
        as_caller("orbit1.testnet");
        let id = dao.add_proposal(ProposalInput { description: "x".into(), kind: ProposalKind::Vote });
        as_caller("maya.testnet");
        dao.act_proposal(id, Action::VoteApprove, ProposalKind::Vote, None);
    }

    fn swap_to(dao: &mut Contract, from: &str, to: &str) {
        let kind_json = orbit_common::swap_kind(&acc(to));
        assert_eq!(
            orbit_common::classify(&kind_json),
            Ok(orbit_common::KindClass::Swap { new_orbit: acc(to) })
        );
        let kind: ProposalKind = serde_json::from_value(kind_json).unwrap();
        let id = propose_and_approve(dao, from, kind);
        assert_eq!(dao.get_proposal(id).proposal.status, ProposalStatus::Approved);
    }

    #[test]
    fn atomic_swap_hands_control_to_new_orbit() {
        let mut dao = new_dao();
        swap_to(&mut dao, "orbit1.testnet", "orbit2.testnet");
        let roles = serde_json::to_value(dao.get_policy()).unwrap()["roles"].clone();
        assert_eq!(roles.as_array().unwrap().len(), 1, "still exactly one role");
        assert_eq!(roles[0]["kind"]["Group"], serde_json::json!(["orbit2.testnet"]));
        // The new orbit can run the DAO.
        let id = propose_and_approve(&mut dao, "orbit2.testnet", ProposalKind::Vote);
        assert_eq!(dao.get_proposal(id).proposal.status, ProposalStatus::Approved);
    }

    #[test]
    #[should_panic(expected = "ERR_PERMISSION_DENIED")]
    fn old_orbit_loses_control_after_swap() {
        let mut dao = new_dao();
        swap_to(&mut dao, "orbit1.testnet", "orbit2.testnet");
        as_caller("orbit1.testnet");
        dao.add_proposal(ProposalInput { description: "x".into(), kind: ProposalKind::Vote });
    }

    #[test]
    fn orbit_can_reject() {
        let mut dao = new_dao();
        as_caller("orbit1.testnet");
        let id = dao.add_proposal(ProposalInput { description: "x".into(), kind: ProposalKind::Vote });
        dao.act_proposal(id, Action::VoteReject, ProposalKind::Vote, None);
        assert_eq!(dao.get_proposal(id).proposal.status, ProposalStatus::Rejected);
    }

    /// Every kind of proposal the bot makes (bot/test/fixtures/kinds.json):
    /// the orbit must accept it, and Sputnik must decode and execute it.
    #[test]
    fn bot_proposal_kinds_work_on_sputnik() {
        let fixtures: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(include_str!("../../../bot/test/fixtures/kinds.json")).unwrap();
        assert!(!fixtures.is_empty());
        for (name, kind_json) in fixtures {
            let class = orbit_common::classify(&kind_json).unwrap_or_else(|e| panic!("{name}: orbit refuses it: {e}"));
            let kind: ProposalKind =
                serde_json::from_value(kind_json).unwrap_or_else(|e| panic!("{name}: Sputnik can't decode it: {e}"));
            if let orbit_common::KindClass::Swap { new_orbit } = class {
                assert_eq!(new_orbit, acc("q.mydao.orbits.testnet"));
            }
            let mut dao = new_dao();
            let id = propose_and_approve(&mut dao, "orbit1.testnet", kind);
            assert_eq!(dao.get_proposal(id).proposal.status, ProposalStatus::Approved, "{name}");
        }
    }
}
