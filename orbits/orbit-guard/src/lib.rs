//! A guard: a signer council between an Orbits DAO's governing orbit and
//! its Sputnik core, as Spaces' GuardWrapper.
//!
//! With a guard on, the core's only governance member is the guard, and the
//! guard's `governance` is the orbit. A proposal that passes in the orbit
//! arrives here as an instruction (`propose_instruction`, from the orbit
//! only); once `threshold` signers confirm it, the guard adds it to the core
//! and approves it, and Sputnik executes it. Signers confirm, revoke or
//! reject; they can never start anything, so a bad signer can only refuse.
//!
//! - **Switching model behind the guard**: governance proposes a function
//!   call from the core to this guard's `set_governance(new orbit)`; once
//!   the signers confirm it, the core makes the call, and the guard takes
//!   the new orbit if it's bound to this core (its vault belongs to the core
//!   and holds its token).
//! - **Replacing signers**: governance proposes a function call to this
//!   guard's `set_signers`. It takes effect at once, without the signers,
//!   but only after the current tenure has ended; before that it's refused.
//!   So signers can't entrench themselves and governance can't remove them
//!   early.
//! - **Turning the guard off**: governance proposes handing the core back
//!   to an orbit (a swap); the signers confirm it like anything else.
//!
//! Proposals that would lock the core (orbit-common) are refused here too.
//! Instructions not confirmed within `instruction_ttl` expire.

use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, log, near, require};
use orbit_common::{Binding, act_proposal_args, add_proposal_args, classify};

const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(30);
/// What sending a confirmed instruction to the core needs: attach 300 Tgas.
const GAS_TO_SEND: Gas = Gas::from_tgas(150);
const SEND_TIMEOUT_NS: u64 = 10 * 60 * 1_000_000_000;
const MAX_DESCRIPTION_LEN: usize = 4_096;
const MAX_KIND_LEN: usize = 16_384;
const MAX_SIGNERS: usize = 20;
const MAX_RESULT_LEN: usize = 4_096;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Instructions,
    Votes,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InstructionState {
    /// Waiting for signers.
    Pending,
    /// Enough signers confirmed; being sent to the core, or to retry with `send`.
    Confirmed,
    /// Approved on the core, which executed it (or, for new signers, applied here).
    Executed,
    Rejected,
    Expired,
}

#[near(serializers = [borsh])]
pub struct Instruction {
    /// The orbit that sent it, which was governance then.
    from: AccountId,
    description: String,
    /// A Sputnik `ProposalKind`, as JSON.
    kind: String,
    created_at: u64,
    confirmations: u16,
    rejections: u16,
    rejected: bool,
    executed: bool,
    core_id: Option<u64>,
    sending_since: Option<u64>,
}

#[near(serializers = [json])]
pub struct InstructionView {
    pub id: u64,
    pub from: AccountId,
    pub description: String,
    pub kind: Value,
    pub state: InstructionState,
    pub created_at: U64,
    pub expires_at: U64,
    pub confirmations: u16,
    pub rejections: u16,
    pub core_proposal_id: Option<u64>,
}

#[near(serializers = [json])]
pub struct GuardView {
    pub dao_id: AccountId,
    pub governance: AccountId,
    pub signers: Vec<AccountId>,
    pub threshold: u16,
    pub tenure_length: U64,
    pub tenure_end: U64,
    pub instruction_ttl: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Vote {
    Confirm,
    Reject,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao_id: AccountId,
    governance: AccountId,
    signers: Vec<AccountId>,
    threshold: u16,
    tenure_length: u64,
    tenure_end: u64,
    instruction_ttl: u64,
    instructions: LookupMap<u64, Instruction>,
    instruction_count: u64,
    /// (instruction, signer): how they voted.
    votes: LookupMap<(u64, AccountId), Vote>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        dao_id: AccountId,
        governance: AccountId,
        signers: Vec<AccountId>,
        threshold: u16,
        tenure_length: U64,
        instruction_ttl: U64,
    ) -> Self {
        check_signers(&signers, threshold);
        require!(tenure_length.0 > 0 && instruction_ttl.0 > 0, "ERR_CONFIG: periods");
        Self {
            dao_id,
            governance,
            signers,
            threshold,
            tenure_length: tenure_length.0,
            tenure_end: env::block_timestamp() + tenure_length.0,
            instruction_ttl: instruction_ttl.0,
            instructions: LookupMap::new(StorageKey::Instructions),
            instruction_count: 0,
            votes: LookupMap::new(StorageKey::Votes),
        }
    }

    // --- From governance ---

    /// Governance (the orbit) sends a passed proposal. Returns its
    /// instruction id. New signers take effect at once if the tenure is
    /// over, and are refused before.
    pub fn propose_instruction(&mut self, description: String, kind: Value) -> u64 {
        let from = env::predecessor_account_id();
        require!(from == self.governance, "ERR_NOT_GOVERNANCE");
        require!(description.len() <= MAX_DESCRIPTION_LEN, "ERR_DESCRIPTION_TOO_LONG");
        let kind_text = kind.to_string();
        require!(kind_text.len() <= MAX_KIND_LEN, "ERR_KIND_TOO_LONG");
        classify(&kind).unwrap_or_else(|err| env::panic_str(err));
        let new_signers = self.signers_call(&kind);
        let id = self.instruction_count;
        self.instruction_count += 1;
        self.instructions.insert(
            id,
            Instruction {
                from,
                description,
                kind: kind_text,
                created_at: env::block_timestamp(),
                confirmations: 0,
                rejections: 0,
                rejected: false,
                executed: false,
                core_id: None,
                sending_since: None,
            },
        );
        if let Some((signers, threshold)) = new_signers {
            require!(env::block_timestamp() >= self.tenure_end, "ERR_TENURE_NOT_OVER");
            self.replace_signers(signers, threshold);
            self.instructions.get_mut(&id).unwrap().executed = true;
        }
        id
    }

    // --- Signers ---

    /// Confirms instruction `id`. The confirmation that reaches the
    /// threshold sends it to the core: attach 300 Tgas.
    pub fn confirm(&mut self, id: u64) -> PromiseOrValue<InstructionState> {
        let state = self.vote(id, Vote::Confirm);
        if state == InstructionState::Confirmed {
            return PromiseOrValue::Promise(self.send_to_core(id));
        }
        PromiseOrValue::Value(state)
    }

    /// Rejects instruction `id`; once too many reject for the threshold to be reached, it's dead.
    pub fn reject(&mut self, id: u64) -> InstructionState {
        self.vote(id, Vote::Reject)
    }

    /// Takes back the caller's vote on instruction `id` while it's pending.
    pub fn revoke(&mut self, id: u64) {
        let signer = env::predecessor_account_id();
        let instruction = self.instructions.get(&id).expect("ERR_NO_INSTRUCTION");
        require!(self.state(instruction) == InstructionState::Pending, "ERR_NOT_PENDING");
        let vote = self.votes.remove(&(id, signer)).expect("ERR_NOT_VOTED");
        let instruction = self.instructions.get_mut(&id).unwrap();
        match vote {
            Vote::Confirm => instruction.confirmations -= 1,
            Vote::Reject => instruction.rejections -= 1,
        }
    }

    /// Sends a confirmed instruction to the core again, if sending failed.
    /// Anyone may call it; attach 300 Tgas.
    pub fn send(&mut self, id: u64) -> Promise {
        let instruction = self.instructions.get(&id).expect("ERR_NO_INSTRUCTION");
        require!(self.state(instruction) == InstructionState::Confirmed, "ERR_NOT_CONFIRMED");
        self.send_to_core(id)
    }

    #[private]
    pub fn on_added(&mut self, id: u64) -> PromiseOrValue<()> {
        match callback_value::<u64>(0) {
            Some(core_id) => {
                self.instructions.get_mut(&id).expect("ERR_NO_INSTRUCTION").core_id = Some(core_id);
                PromiseOrValue::Promise(self.approve_on_core(id))
            }
            None => {
                log!("The core refused instruction {}", id);
                self.instructions.get_mut(&id).expect("ERR_NO_INSTRUCTION").sending_since = None;
                PromiseOrValue::Value(())
            }
        }
    }

    #[private]
    pub fn on_approved(&mut self, id: u64) -> bool {
        let ok = env::promise_result_checked(0, MAX_RESULT_LEN).is_ok();
        let instruction = self.instructions.get_mut(&id).expect("ERR_NO_INSTRUCTION");
        instruction.sending_since = None;
        if ok {
            instruction.executed = true;
        } else {
            log!("Core approval of instruction {} failed; call send to retry", id);
        }
        ok
    }

    // --- From the core ---

    /// The core (a confirmed instruction) moves the guard to another orbit,
    /// if that orbit is bound to this core. Returns whether it did.
    pub fn set_governance(&mut self, governance: AccountId) -> Promise {
        require!(env::predecessor_account_id() == self.dao_id, "ERR_NOT_DAO");
        Promise::new(governance.clone())
            .function_call("get_binding", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_VIEW)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).with_unused_gas_weight(1).on_new_binding(governance))
    }

    #[private]
    pub fn on_new_binding(&mut self, governance: AccountId) -> PromiseOrValue<bool> {
        match callback_value::<Binding>(0) {
            Some(Binding { dao_id, staking_id: Some(staking), token_id: Some(token), governance: None }) if dao_id == self.dao_id => {
                let view = |method: &str| Promise::new(staking.clone()).function_call(method, b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_VIEW);
                PromiseOrValue::Promise(
                    view("get_dao")
                        .and(view("get_token"))
                        .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_new_vault(governance, token)),
                )
            }
            _ => {
                log!("{} isn't an orbit bound to {}; governance unchanged", governance, self.dao_id);
                PromiseOrValue::Value(false)
            }
        }
    }

    #[private]
    pub fn on_new_vault(&mut self, governance: AccountId, token: AccountId) -> bool {
        let ok = callback_value::<AccountId>(0).as_ref() == Some(&self.dao_id) && callback_value::<AccountId>(1).as_ref() == Some(&token);
        if ok {
            log!("Governance moved from {} to {}", self.governance, governance);
            self.governance = governance;
        } else {
            log!("{}'s staking vault isn't {}'s, or holds another token; governance unchanged", governance, self.dao_id);
        }
        ok
    }

    // --- Views ---

    pub fn get_dao(&self) -> AccountId {
        self.dao_id.clone()
    }

    pub fn get_governance(&self) -> AccountId {
        self.governance.clone()
    }

    /// What this guard is bound to, for an orbit checking a swap to it.
    pub fn get_binding(&self) -> Binding {
        Binding { dao_id: self.dao_id.clone(), staking_id: None, token_id: None, governance: Some(self.governance.clone()) }
    }

    pub fn get_config(&self) -> GuardView {
        GuardView {
            dao_id: self.dao_id.clone(),
            governance: self.governance.clone(),
            signers: self.signers.clone(),
            threshold: self.threshold,
            tenure_length: U64(self.tenure_length),
            tenure_end: U64(self.tenure_end),
            instruction_ttl: U64(self.instruction_ttl),
        }
    }

    pub fn get_instruction_count(&self) -> u64 {
        self.instruction_count
    }

    pub fn get_instruction(&self, id: u64) -> Option<InstructionView> {
        self.instructions.get(&id).map(|i| InstructionView {
            id,
            from: i.from.clone(),
            description: i.description.clone(),
            kind: serde_json::from_str(&i.kind).unwrap_or(Value::Null),
            state: self.state(i),
            created_at: U64(i.created_at),
            expires_at: U64(i.created_at + self.instruction_ttl),
            confirmations: i.confirmations,
            rejections: i.rejections,
            core_proposal_id: i.core_id,
        })
    }

    pub fn get_instructions(&self, from_index: u64, limit: u64) -> Vec<InstructionView> {
        (from_index..self.instruction_count.min(from_index.saturating_add(limit))).filter_map(|id| self.get_instruction(id)).collect()
    }

    pub fn get_vote(&self, id: u64, signer: AccountId) -> Option<Vote> {
        self.votes.get(&(id, signer)).copied()
    }
}

impl Contract {
    fn state(&self, i: &Instruction) -> InstructionState {
        if i.executed {
            InstructionState::Executed
        } else if i.rejected {
            InstructionState::Rejected
        } else if i.confirmations >= self.threshold {
            InstructionState::Confirmed
        } else if env::block_timestamp() > i.created_at + self.instruction_ttl {
            InstructionState::Expired
        } else {
            InstructionState::Pending
        }
    }

    fn vote(&mut self, id: u64, vote: Vote) -> InstructionState {
        let signer = env::predecessor_account_id();
        require!(self.signers.contains(&signer), "ERR_NOT_SIGNER");
        let instruction = self.instructions.get(&id).expect("ERR_NO_INSTRUCTION");
        require!(self.state(instruction) == InstructionState::Pending, "ERR_NOT_PENDING");
        // Signers who joined after it was sent still count: they're the signers now.
        require!(!self.votes.contains_key(&(id, signer.clone())), "ERR_ALREADY_VOTED");
        self.votes.insert((id, signer), vote);
        let most_rejections = self.signers.len() as u16 - self.threshold;
        let instruction = self.instructions.get_mut(&id).unwrap();
        match vote {
            Vote::Confirm => instruction.confirmations += 1,
            Vote::Reject => {
                instruction.rejections += 1;
                instruction.rejected = instruction.rejections > most_rejections;
            }
        }
        self.state(self.instructions.get(&id).unwrap())
    }

    fn send_to_core(&mut self, id: u64) -> Promise {
        require!(env::prepaid_gas().saturating_sub(env::used_gas()) >= GAS_TO_SEND, "ERR_NOT_ENOUGH_GAS: attach 300 Tgas");
        let now = env::block_timestamp();
        let instruction = self.instructions.get_mut(&id).expect("ERR_NO_INSTRUCTION");
        if let Some(since) = instruction.sending_since {
            require!(now > since + SEND_TIMEOUT_NS, "ERR_ALREADY_SENDING");
        }
        instruction.sending_since = Some(now);
        if instruction.core_id.is_some() {
            return self.approve_on_core(id);
        }
        let kind: Value = serde_json::from_str(&instruction.kind).expect("ERR_KIND_NOT_JSON");
        Promise::new(self.dao_id.clone())
            .function_call("add_proposal", add_proposal_args(&instruction.description, &kind), NearToken::from_yoctonear(0), GAS_ADD_PROPOSAL)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK.saturating_add(GAS_ACT_PROPOSAL))
                    .with_unused_gas_weight(1)
                    .on_added(id),
            )
    }

    fn approve_on_core(&self, id: u64) -> Promise {
        let instruction = self.instructions.get(&id).expect("ERR_NO_INSTRUCTION");
        let core_id = instruction.core_id.expect("ERR_NOT_ON_CORE");
        let kind: Value = serde_json::from_str(&instruction.kind).expect("ERR_KIND_NOT_JSON");
        Promise::new(self.dao_id.clone())
            .function_call_weight("act_proposal", act_proposal_args(core_id, &kind), NearToken::from_yoctonear(0), GAS_ACT_PROPOSAL, GasWeight(1))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).with_unused_gas_weight(0).on_approved(id))
    }

    /// A call to this guard's `set_signers`, as a proposal kind: the new
    /// signers and threshold. Any other call to this guard is refused, since
    /// only the core may make it (`set_governance`, through the core).
    fn signers_call(&self, kind: &Value) -> Option<(Vec<AccountId>, u16)> {
        let call = kind.get("FunctionCall")?;
        if call.get("receiver_id")?.as_str()? != env::current_account_id().as_str() {
            return None;
        }
        let actions = call.get("actions")?.as_array()?;
        let set_signers = actions.iter().any(|a| a.get("method_name").and_then(Value::as_str) == Some("set_signers"));
        if !set_signers {
            return None;
        }
        require!(actions.len() == 1, "ERR_SET_SIGNERS_ALONE");
        let args: Base64VecU8 = serde_json::from_value(actions[0].get("args")?.clone()).ok()?;
        let args: Value = serde_json::from_slice(&args.0).unwrap_or_else(|_| env::panic_str("ERR_SET_SIGNERS_ARGS"));
        let signers: Vec<AccountId> = serde_json::from_value(args.get("signers")?.clone()).unwrap_or_else(|_| env::panic_str("ERR_SET_SIGNERS_ARGS"));
        let threshold = args.get("threshold")?.as_u64().and_then(|t| u16::try_from(t).ok()).unwrap_or_else(|| env::panic_str("ERR_SET_SIGNERS_ARGS"));
        Some((signers, threshold))
    }

    fn replace_signers(&mut self, signers: Vec<AccountId>, threshold: u16) {
        check_signers(&signers, threshold);
        log!("Signers replaced: {:?}, {} to confirm", signers, threshold);
        self.signers = signers;
        self.threshold = threshold;
        self.tenure_end = env::block_timestamp() + self.tenure_length;
    }
}

fn check_signers(signers: &[AccountId], threshold: u16) {
    require!(!signers.is_empty() && signers.len() <= MAX_SIGNERS, "ERR_CONFIG: 1 to 20 signers");
    require!(threshold > 0 && usize::from(threshold) <= signers.len(), "ERR_CONFIG: threshold");
    for (i, s) in signers.iter().enumerate() {
        require!(!signers[i + 1..].contains(s), "ERR_CONFIG: a signer is listed twice");
    }
}

fn callback_value<T: near_sdk::serde::de::DeserializeOwned>(index: u64) -> Option<T> {
    let bytes = env::promise_result_checked(index, MAX_RESULT_LEN).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests;

/// The `FunctionCall` kind that replaces a guard's signers, for governance to propose.
pub fn set_signers_kind(guard: &AccountId, signers: &[AccountId], threshold: u16) -> Value {
    let args = json!({ "signers": signers, "threshold": threshold }).to_string();
    json!({ "FunctionCall": { "receiver_id": guard, "actions": [{
        "method_name": "set_signers",
        "args": Base64VecU8(args.into_bytes()),
        "deposit": "0",
        "gas": "10000000000000"
    }] } })
}
