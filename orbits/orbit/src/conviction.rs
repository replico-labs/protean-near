//! Conviction voting, as in Spaces: a member backs one proposal at a time
//! with all their unlocked stake, which the staking contract locks while it
//! backs the proposal. A proposal's conviction moves linearly toward its
//! current support at `growth_per_second`, so sustained support outweighs a
//! sudden spike. It may queue once conviction reaches what it requires,
//! which grows with how much it pays out.
//!
//! The orbit must be the staking contract's locker (`claim_locker`).

use super::*;

/// Multipliers are fixed point with 24 decimals, NEAR's precision: a
/// multiplier of 50 adds 50 conviction per whole NEAR (10^24 yoctoNEAR).
const SCALE: u128 = 1_000_000_000_000_000_000_000_000;

/// What a proposal of `kind` requires: the minimum, plus the multiplier for
/// payouts in NEAR or the DAO's token, or the governance bar for anything
/// else (function calls, policy changes, swaps, other tokens).
pub fn required_conviction(c: &ConvictionRules, kind: &Value, token_id: &AccountId) -> u128 {
    if kind.as_str() == Some("Vote") {
        return c.min_conviction.0;
    }
    let Some(transfer) = kind.get("Transfer") else {
        return c.governance_conviction.0;
    };
    let amount: u128 = transfer.get("amount").and_then(Value::as_str).and_then(|a| a.parse().ok()).unwrap_or(u128::MAX);
    let multiplier = match transfer.get("token_id").and_then(Value::as_str) {
        Some("") => c.near_multiplier.0,
        Some(t) if t == token_id.as_str() => c.token_multiplier.0,
        _ => return c.governance_conviction.0,
    };
    // amount * multiplier / SCALE, without overflow.
    let extra = (amount / SCALE).saturating_mul(multiplier).saturating_add((amount % SCALE).saturating_mul(multiplier) / SCALE);
    c.min_conviction.0.saturating_add(extra)
}

/// A proposal's conviction at `now`, and the time it's settled up to.
pub fn settled(p: &Proposal, c: &ConvictionRules, now: u64) -> (u128, u64) {
    let seconds = now.saturating_sub(p.conviction_at) / 1_000_000_000;
    let at = p.conviction_at + seconds * 1_000_000_000;
    let step = c.growth_per_second.0.saturating_mul(u128::from(seconds));
    let conviction = if p.conviction < p.support {
        p.conviction + step.min(p.support - p.conviction)
    } else {
        p.conviction - step.min(p.conviction - p.support)
    };
    (conviction, at)
}

#[near]
impl Contract {
    /// Backs proposal `id` with all the caller's unlocked stake, moving their
    /// support from any proposal they backed before.
    pub fn support(&mut self, id: u64) -> Promise {
        let rules = self.conviction_rules().clone();
        let account = env::predecessor_account_id();
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Active, "ERR_PROPOSAL_NOT_ACTIVE");
        let previous = self.supports.get(&account).copied();
        if let Some((current, weight)) = previous {
            require!(current != id, "ERR_ALREADY_SUPPORTING");
            require!(weight > 0, "ERR_SUPPORT_PENDING");
        }
        // Mark the support pending before any call, so it can't run twice at once.
        self.supports.insert(account.clone(), (id, 0));
        let mut staking = Promise::new(self.staking_id.clone());
        if let Some((current, weight)) = previous {
            self.change_support(current, weight, false, &rules);
            staking = staking.function_call(
                "unlock",
                json!({ "account_id": account, "amount": U128(weight) }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            );
        }
        // One batch: the release, then the new lock, in order.
        staking
            .function_call("lock_available", json!({ "account_id": account }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_VIEW)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_locked(id, account))
    }

    #[private]
    pub fn on_locked(&mut self, id: u64, account: AccountId) -> U128 {
        let locked = callback_value::<U128>().map_or(0, |a| a.0);
        if locked == 0 {
            log!("{} had no unlocked stake to back proposal {}", account, id);
            self.supports.remove(&account);
            return U128(0);
        }
        let rules = self.conviction_rules().clone();
        self.change_support(id, locked, true, &rules);
        self.supports.insert(account, (id, locked));
        U128(locked)
    }

    /// Withdraws the caller's support and releases their stake.
    pub fn withdraw_support(&mut self) -> Promise {
        let rules = self.conviction_rules().clone();
        let account = env::predecessor_account_id();
        let (id, weight) = self.supports.get(&account).copied().expect("ERR_NOT_SUPPORTING");
        require!(weight > 0, "ERR_SUPPORT_PENDING");
        self.supports.remove(&account);
        self.change_support(id, weight, false, &rules);
        Promise::new(self.staking_id.clone()).function_call(
            "unlock",
            json!({ "account_id": account, "amount": U128(weight) }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_VIEW,
        )
    }

    /// Queues proposal `id` once its conviction reaches what it requires.
    pub fn queue(&mut self, id: u64) {
        let rules = self.conviction_rules().clone();
        let now = env::block_timestamp();
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Active, "ERR_PROPOSAL_NOT_ACTIVE");
        let proposal = self.proposals.get_mut(&id).unwrap();
        (proposal.conviction, proposal.conviction_at) = settled(proposal, &rules, now);
        require!(proposal.conviction >= proposal.required, "ERR_NOT_ENOUGH_CONVICTION");
        proposal.queued_at = Some(now);
    }

    /// The proposal `account_id` backs and with how much (0 while pending).
    pub fn get_support(&self, account_id: AccountId) -> Option<(u64, U128)> {
        self.supports.get(&account_id).map(|(id, w)| (*id, U128(*w)))
    }
}

impl Contract {
    fn conviction_rules(&self) -> &ConvictionRules {
        match &self.model {
            Model::Conviction(c) => c,
            _ => env::panic_str("ERR_NOT_CONVICTION"),
        }
    }

    /// Settles conviction up to now, then changes the support it grows toward.
    fn change_support(&mut self, id: u64, weight: u128, add: bool, rules: &ConvictionRules) {
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        (proposal.conviction, proposal.conviction_at) = settled(proposal, rules, env::block_timestamp());
        proposal.support = if add { proposal.support + weight } else { proposal.support.saturating_sub(weight) };
    }
}
