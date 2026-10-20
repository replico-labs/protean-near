//! Shared rules for every orbit: which Sputnik proposal kinds an orbit may
//! send to its core, and the exact arguments of the calls it makes there.
//!
//! An orbit is the core's only member (see docs/SPEC.md), so a proposal that
//! breaks that arrangement would lock the DAO for good. `classify` refuses
//! those before anyone votes on them.

use near_sdk::AccountId;
use near_sdk::serde_json::{self, Value, json};

/// The core's one role, whose only member is the current orbit.
pub const GOVERNANCE_ROLE: &str = "governance";

/// Everything the orbit may do on the core.
pub const GOVERNANCE_PERMISSIONS: [&str; 5] = [
    "*:AddProposal",
    "*:VoteApprove",
    "*:VoteReject",
    "*:VoteRemove",
    "*:Finalize",
];

/// The shortest core proposal period a proposal may set: the orbit adds a
/// proposal and approves it a few blocks later, so it only needs to be long
/// enough to retry a failed approval.
pub const MIN_CORE_PROPOSAL_PERIOD_NS: u64 = 3_600_000_000_000;

/// Every `ProposalKind` variant of Sputnik DAO v2.
const SPUTNIK_KINDS: [&str; 17] = [
    "ChangeConfig",
    "ChangePolicy",
    "AddMemberToRole",
    "RemoveMemberFromRole",
    "FunctionCall",
    "UpgradeSelf",
    "UpgradeRemote",
    "Transfer",
    "SetStakingContract",
    "AddBounty",
    "BountyDone",
    "Vote",
    "FactoryInfoUpdate",
    "ChangePolicyAddOrUpdateRole",
    "ChangePolicyRemoveRole",
    "ChangePolicyUpdateDefaultVotePolicy",
    "ChangePolicyUpdateParameters",
];

#[derive(Debug, PartialEq)]
pub enum KindClass {
    /// Sent to the core as is.
    Normal,
    /// Hands the core to `new_orbit`. The orbit checks that `new_orbit` is
    /// bound to this core before sending it.
    Swap { new_orbit: AccountId },
}

/// The core's `governance` role with `orbit` as its only member.
pub fn governance_role(orbit: &AccountId) -> Value {
    json!({
        "name": GOVERNANCE_ROLE,
        "kind": { "Group": [orbit] },
        "permissions": GOVERNANCE_PERMISSIONS,
        "vote_policy": {}
    })
}

/// The policy every Orbits core is created with.
pub fn core_policy(orbit: &AccountId) -> Value {
    json!({
        "roles": [governance_role(orbit)],
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1] },
        "proposal_bond": "0",
        "proposal_period": "604800000000000",
        "bounty_bond": "0",
        "bounty_forgiveness_period": "86400000000000"
    })
}

/// A Sputnik swap proposal: hands the core to `new_orbit`.
pub fn swap_kind(new_orbit: &AccountId) -> Value {
    json!({ "ChangePolicyAddOrUpdateRole": { "role": governance_role(new_orbit) } })
}

/// Parses proposal kind JSON and checks the orbit may send it.
pub fn parse_kind(text: &str) -> Result<(Value, KindClass), &'static str> {
    let kind: Value = serde_json::from_str(text).map_err(|_| "ERR_KIND_NOT_JSON")?;
    let class = classify(&kind)?;
    Ok((kind, class))
}

/// Decides whether the orbit may send `kind` to its core.
pub fn classify(kind: &Value) -> Result<KindClass, &'static str> {
    // Unit variants (only `Vote`) serialize as a bare string.
    if kind.as_str() == Some("Vote") {
        return Ok(KindClass::Normal);
    }
    let map = kind.as_object().ok_or("ERR_KIND_SHAPE")?;
    if map.len() != 1 {
        return Err("ERR_KIND_SHAPE");
    }
    let (name, body) = map.iter().next().unwrap();
    if !SPUTNIK_KINDS.contains(&name.as_str()) {
        return Err("ERR_KIND_UNKNOWN");
    }
    let names_governance = |field: &str| body.get(field).and_then(Value::as_str) == Some(GOVERNANCE_ROLE);
    match name.as_str() {
        // Replacing the whole policy or the default vote policy could remove
        // the orbit or make its single vote insufficient.
        "ChangePolicy" | "ChangePolicyUpdateDefaultVotePolicy" => Err("ERR_KIND_LOCKS_CORE"),
        "ChangePolicyRemoveRole" if names_governance("role") => Err("ERR_KIND_LOCKS_CORE"),
        "AddMemberToRole" | "RemoveMemberFromRole" if names_governance("role") => Err("ERR_KIND_LOCKS_CORE"),
        "ChangePolicyUpdateParameters" => check_parameters(body).map(|_| KindClass::Normal),
        "ChangePolicyAddOrUpdateRole" => {
            let role = body.get("role").ok_or("ERR_KIND_SHAPE")?;
            if role.get("name").and_then(Value::as_str) != Some(GOVERNANCE_ROLE) {
                return Ok(KindClass::Normal);
            }
            let new_orbit = swap_target(role).ok_or("ERR_SWAP_SHAPE")?;
            Ok(KindClass::Swap { new_orbit })
        }
        _ => Ok(KindClass::Normal),
    }
}

/// A swap must keep the governance role exactly as created, with one new
/// member. Permissions are a set on Sputnik, so their order doesn't matter.
fn swap_target(role: &Value) -> Option<AccountId> {
    let fields = role.as_object()?;
    if fields.len() != 4 || fields.get("vote_policy")? != &json!({}) {
        return None;
    }
    let members = role.get("kind")?.get("Group")?.as_array()?;
    if role.get("kind")?.as_object()?.len() != 1 || members.len() != 1 {
        return None;
    }
    let mut permissions: Vec<&str> =
        role.get("permissions")?.as_array()?.iter().map(Value::as_str).collect::<Option<_>>()?;
    permissions.sort_unstable();
    let mut expected = GOVERNANCE_PERMISSIONS;
    expected.sort_unstable();
    if permissions != expected {
        return None;
    }
    members[0].as_str()?.parse().ok()
}

/// A bond would stop the orbit adding proposals (it attaches none), and a very
/// short period would expire them before they can be approved.
fn check_parameters(body: &Value) -> Result<(), &'static str> {
    let params = body.get("parameters").ok_or("ERR_KIND_SHAPE")?;
    match params.get("proposal_bond") {
        None | Some(Value::Null) => {}
        Some(bond) if bond.as_str() == Some("0") => {}
        Some(_) => return Err("ERR_KIND_LOCKS_CORE"),
    }
    match params.get("proposal_period") {
        None | Some(Value::Null) => {}
        Some(period) => {
            let ns: u64 = period.as_str().and_then(|s| s.parse().ok()).ok_or("ERR_KIND_SHAPE")?;
            if ns < MIN_CORE_PROPOSAL_PERIOD_NS {
                return Err("ERR_KIND_LOCKS_CORE");
            }
        }
    }
    Ok(())
}

/// Arguments of the core's `add_proposal`.
pub fn add_proposal_args(description: &str, kind: &Value) -> Vec<u8> {
    json!({ "proposal": { "description": description, "kind": kind } }).to_string().into_bytes()
}

/// Arguments of the core's `act_proposal` approving proposal `id`.
pub fn act_proposal_args(id: u64, kind: &Value) -> Vec<u8> {
    json!({ "id": id, "action": "VoteApprove", "proposal": kind }).to_string().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    #[test]
    fn transfer_and_vote_are_normal() {
        let transfer = json!({ "Transfer": { "token_id": "", "receiver_id": "a.testnet", "amount": "1" } });
        assert_eq!(classify(&transfer), Ok(KindClass::Normal));
        assert_eq!(classify(&json!("Vote")), Ok(KindClass::Normal));
    }

    #[test]
    fn swap_is_recognised() {
        let kind = swap_kind(&acc("orbit2.testnet"));
        assert_eq!(classify(&kind), Ok(KindClass::Swap { new_orbit: acc("orbit2.testnet") }));
    }

    #[test]
    fn swap_must_keep_role_intact() {
        let mut role = governance_role(&acc("orbit2.testnet"));
        role["permissions"] = json!(["*:AddProposal"]);
        let kind = json!({ "ChangePolicyAddOrUpdateRole": { "role": role } });
        assert_eq!(classify(&kind), Err("ERR_SWAP_SHAPE"));

        let mut role = governance_role(&acc("orbit2.testnet"));
        role["kind"] = json!({ "Group": ["orbit2.testnet", "orbit3.testnet"] });
        let kind = json!({ "ChangePolicyAddOrUpdateRole": { "role": role } });
        assert_eq!(classify(&kind), Err("ERR_SWAP_SHAPE"));
    }

    #[test]
    fn other_roles_may_change() {
        let role = json!({ "name": "guardian", "kind": { "Group": ["g.testnet"] },
            "permissions": ["policy_add_or_update_role:*"], "vote_policy": {} });
        let kind = json!({ "ChangePolicyAddOrUpdateRole": { "role": role } });
        assert_eq!(classify(&kind), Ok(KindClass::Normal));
    }

    #[test]
    fn kinds_that_lock_the_core_are_refused() {
        for kind in [
            json!({ "ChangePolicy": { "policy": ["a.testnet"] } }),
            json!({ "ChangePolicyUpdateDefaultVotePolicy": { "vote_policy": {} } }),
            json!({ "ChangePolicyRemoveRole": { "role": "governance" } }),
            json!({ "RemoveMemberFromRole": { "member_id": "orbit1.testnet", "role": "governance" } }),
            json!({ "AddMemberToRole": { "member_id": "a.testnet", "role": "governance" } }),
            json!({ "ChangePolicyUpdateParameters": { "parameters": { "proposal_bond": "1" } } }),
            json!({ "ChangePolicyUpdateParameters": { "parameters": { "proposal_period": "1000" } } }),
        ] {
            assert_eq!(classify(&kind), Err("ERR_KIND_LOCKS_CORE"), "{kind}");
        }
    }

    #[test]
    fn safe_parameters_pass() {
        let kind = json!({ "ChangePolicyUpdateParameters": { "parameters": {
            "proposal_bond": "0", "proposal_period": "86400000000000" } } });
        assert_eq!(classify(&kind), Ok(KindClass::Normal));
    }

    #[test]
    fn bad_shapes_are_refused() {
        assert_eq!(parse_kind("not json").err(), Some("ERR_KIND_NOT_JSON"));
        assert_eq!(classify(&json!({ "Mint": {} })), Err("ERR_KIND_UNKNOWN"));
        assert_eq!(classify(&json!({ "Transfer": {}, "Vote": {} })), Err("ERR_KIND_SHAPE"));
        assert_eq!(classify(&json!(5)), Err("ERR_KIND_SHAPE"));
    }
}
