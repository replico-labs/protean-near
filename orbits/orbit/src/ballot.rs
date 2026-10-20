//! Stake-weighted votes: token-weighted, quadratic, liquid and the
//! challenged vote of optimistic. A vote's weight is the voter's stake at
//! the proposal's snapshot, read from the staking contract; until it
//! arrives the vote is recorded as pending, so it can't be cast twice.

use super::*;

/// How far a liquid delegation chain is followed, as in Spaces.
pub const MAX_CHAIN_DEPTH: usize = 5;

#[near(serializers = [json])]
pub struct VoteOutcome {
    pub counted: bool,
    pub weight: U128,
    pub state: State,
}

#[cfg(any(feature = "ballot", feature = "council"))]
#[near]
impl Contract {
    /// Votes on proposal `id`. Council models count one vote per seat at
    /// once; stake-weighted models read the voter's stake at the snapshot
    /// first and count the vote when it arrives.
    pub fn vote(&mut self, id: u64, choice: Choice) -> PromiseOrValue<VoteOutcome> {
        #[cfg(feature = "council")]
        if self.model.council().is_some() {
            return PromiseOrValue::Value(self.council_vote(id, choice));
        }
        #[cfg(feature = "ballot")]
        return PromiseOrValue::Promise(self.stake_vote(id, choice));
        #[cfg(not(feature = "ballot"))]
        env::panic_str("ERR_NOT_COUNCIL_MODEL")
    }
}

#[cfg(feature = "ballot")]
#[near]
impl Contract {
    /// Counts `voter`'s pending vote with the stake that arrived; drops it if
    /// they had no stake at the snapshot or the read failed.
    #[private]
    pub fn on_vote_weight(&mut self, id: u64, voter: AccountId) -> VoteOutcome {
        let weights = callback_value::<(U128, U128)>();
        let quadratic = matches!(self.model, Model::Quadratic(_));
        let key = (id, voter);
        let mut receipt = self.receipts.get(&key).cloned().expect("ERR_NO_RECEIPT");
        let proposal = self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL");
        let counted = match weights {
            Some((own, total)) if own.0 > 0 => {
                let weight = if quadratic { isqrt(own.0) } else { own.0 };
                let total = if quadratic { isqrt(total.0) } else { total.0 };
                proposal.total.get_or_insert(total);
                match receipt.choice {
                    Choice::For => proposal.for_ += weight,
                    Choice::Against => proposal.against += weight,
                    Choice::Abstain => proposal.abstain += weight,
                }
                proposal.voters += 1;
                receipt.weight = U128(weight);
                receipt.pending = false;
                self.receipts.insert(key, receipt.clone());
                true
            }
            _ => {
                log!("{} had no stake at proposal {}'s snapshot; vote not counted", key.1, id);
                self.receipts.remove(&key);
                false
            }
        };
        let state = self.state(self.proposals.get(&id).unwrap());
        VoteOutcome { counted, weight: receipt.weight, state }
    }
}

#[cfg(feature = "liquid")]
#[near]
impl Contract {

    /// Liquid: delegates the caller's vote to `to`, replacing any earlier delegation.
    pub fn delegate(&mut self, to: AccountId) {
        require!(matches!(self.model, Model::Liquid(_)), "ERR_NOT_LIQUID");
        let from = env::predecessor_account_id();
        require!(from != to, "ERR_SELF_DELEGATION");
        self.delegations.insert(from, to);
    }

    pub fn undelegate(&mut self) {
        require!(self.delegations.remove(&env::predecessor_account_id()).is_some(), "ERR_NOT_DELEGATED");
    }

    /// Liquid: counts `delegator`'s stake with the first account in their
    /// delegation chain (up to MAX_CHAIN_DEPTH) that has voted on `id`.
    /// Anyone may call it, once per delegator per proposal.
    pub fn resolve_delegated_vote(&mut self, id: u64, delegator: AccountId) -> Promise {
        require!(matches!(self.model, Model::Liquid(_)), "ERR_NOT_LIQUID");
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Active, "ERR_PROPOSAL_NOT_ACTIVE");
        let snapshot = proposal.created_at;
        require!(!self.receipts.contains_key(&(id, delegator.clone())), "ERR_ALREADY_VOTED");
        let mut current = self.delegations.get(&delegator).cloned().expect("ERR_NOT_DELEGATED");
        let mut found = None;
        for _ in 0..MAX_CHAIN_DEPTH {
            if let Some(receipt) = self.receipts.get(&(id, current.clone())).filter(|r| !r.pending) {
                found = Some((receipt.choice, current.clone()));
                break;
            }
            match self.delegations.get(&current) {
                Some(next) => current = next.clone(),
                None => break,
            }
        }
        let (choice, via) = found.expect("ERR_DELEGATE_HAS_NOT_VOTED");
        self.receipts.insert((id, delegator.clone()), Receipt { choice, weight: U128(0), pending: true, via: Some(via) });
        self.weights_at(&delegator, snapshot).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_vote_weight(id, delegator),
        )
    }

    pub fn get_delegate(&self, account_id: AccountId) -> Option<AccountId> {
        self.delegations.get(&account_id).cloned()
    }

    /// Where `account_id`'s delegation chain ends, and after how many hops.
    pub fn get_chain_tip(&self, account_id: AccountId) -> (AccountId, u32) {
        let (mut tip, mut hops) = (account_id, 0);
        while (hops as usize) < MAX_CHAIN_DEPTH {
            match self.delegations.get(&tip) {
                Some(next) => {
                    tip = next.clone();
                    hops += 1;
                }
                None => break,
            }
        }
        (tip, hops)
    }
}

#[cfg(feature = "optimistic")]
#[near]
impl Contract {

    /// Optimistic: once a challenged proposal's vote is over, pays the bond
    /// to the treasury if the proposal passed anyway, or back to the
    /// challenger if it failed. Anyone may call it.
    pub fn resolve_challenge(&mut self, id: u64) -> Promise {
        let Model::Optimistic { challenge_bond, .. } = &self.model else {
            env::panic_str("ERR_NOT_OPTIMISTIC");
        };
        let bond = challenge_bond.0;
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        let challenger = proposal.challenger.clone().expect("ERR_NOT_CHALLENGED");
        require!(!proposal.bond_resolved, "ERR_BOND_RESOLVED");
        let receiver = match self.state(proposal) {
            State::Succeeded | State::Executed | State::Expired => self.dao_id.clone(),
            State::Defeated => challenger,
            _ => env::panic_str("ERR_VOTING_NOT_OVER"),
        };
        self.proposals.get_mut(&id).unwrap().bond_resolved = true;
        self.transfer_token(&receiver, bond)
    }
}

impl Contract {
    /// Records `voter`'s vote as pending and reads their stake at the snapshot.
    #[cfg(feature = "ballot")]
    fn stake_vote(&mut self, id: u64, choice: Choice) -> Promise {
        require!(!matches!(self.model, Model::Conviction(_)), "ERR_USE_SUPPORT");
        let voter = env::predecessor_account_id();
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Active, "ERR_PROPOSAL_NOT_ACTIVE");
        let snapshot = proposal.created_at;
        require!(!self.receipts.contains_key(&(id, voter.clone())), "ERR_ALREADY_VOTED");
        self.receipts.insert((id, voter.clone()), Receipt { choice, weight: U128(0), pending: true, via: None });
        self.weights_at(&voter, snapshot).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_vote_weight(id, voter),
        )
    }

    /// Optimistic: the DAO's token sent with `{"challenge": id}` challenges
    /// that proposal. The bond is kept; returns what's beyond it.
    pub(crate) fn challenge_with_bond(&mut self, id: u64, sender_id: AccountId, amount: u128) -> u128 {
        let Model::Optimistic { rules, challenge_bond, .. } = &self.model else {
            env::panic_str("ERR_NOT_OPTIMISTIC");
        };
        let (voting_period, bond) = (rules.voting_period.0, challenge_bond.0);
        require!(amount >= bond, "ERR_BOND_TOO_SMALL");
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::ChallengeWindow, "ERR_NOT_CHALLENGEABLE");
        let proposal = self.proposals.get_mut(&id).unwrap();
        proposal.challenger = Some(sender_id);
        proposal.end = env::block_timestamp() + voting_period;
        amount - bond
    }
}
