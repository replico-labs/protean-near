//! Council models, as in Spaces. A council proposes and votes, one seat
//! one vote; the models differ in how the council is chosen.
//!
//! - Delegate: stakers elect the council for a term (plurality, top
//!   `council_size` win) and can recall a member by a stake-weighted vote.
//! - Sortition: the council is drawn at random from stakers who opted in.
//!   NEAR's block random seed replaces Spaces' Pyth Entropy: it needs no
//!   oracle or fee, but the block producer could bias it.

use super::*;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Election {
    pub candidacy_end: U64,
    pub voting_end: U64,
    pub snapshot: U64,
    pub candidates: Vec<AccountId>,
    pub finalized: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Recall {
    pub member: AccountId,
    pub end: U64,
    pub snapshot: U64,
    pub for_votes: U128,
    pub against_votes: U128,
    pub abstain_votes: U128,
    pub total: Option<U128>,
    pub finalized: bool,
    pub removed: bool,
}

/// One seat, one vote: enough members voted, and enough of the decisive ones voted for.
pub fn council_passes(p: &Proposal, c: &CouncilRules) -> bool {
    let turnout = p.for_ + p.against + p.abstain;
    let decisive = p.for_ + p.against;
    turnout >= u128::from(c.quorum) && decisive > 0 && p.for_ * u128::from(MAX_BPS) >= decisive * u128::from(c.approval_bps)
}

#[near]
impl Contract {
    // --- Delegate: elections ---

    /// Opens an election once the current term has ended.
    pub fn start_election(&mut self) -> u64 {
        let rules = self.delegate_rules().clone();
        let now = env::block_timestamp();
        require!(now >= self.term_end, "ERR_TERM_NOT_OVER");
        if let Some(last) = self.election_count.checked_sub(1) {
            require!(self.elections[&last].finalized, "ERR_ELECTION_ACTIVE");
        }
        let id = self.election_count;
        let candidacy_end = now + rules.candidacy_period.0;
        self.elections.insert(
            id,
            Election {
                candidacy_end: U64(candidacy_end),
                voting_end: U64(candidacy_end + rules.election_period.0),
                snapshot: U64(now),
                candidates: vec![],
                finalized: false,
            },
        );
        self.election_count += 1;
        id
    }

    /// Stands for election `id`, if the caller's current stake meets the candidacy threshold.
    pub fn declare_candidacy(&mut self, id: u64) -> Promise {
        self.delegate_rules();
        let election = self.elections.get(&id).expect("ERR_NO_ELECTION");
        require!(env::block_timestamp() <= election.candidacy_end.0, "ERR_CANDIDACY_CLOSED");
        let account = env::predecessor_account_id();
        require!(!self.candidates.contains(&(id, account.clone())), "ERR_ALREADY_CANDIDATE");
        self.current_stake(&account).then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_candidate_stake(id, account))
    }

    #[private]
    pub fn on_candidate_stake(&mut self, id: u64, account: AccountId) -> bool {
        let threshold = self.delegate_rules().candidacy_threshold.0;
        let stake = callback_value::<(U128, U128)>().map_or(0, |(own, _)| own.0);
        let election = self.elections.get_mut(&id).expect("ERR_NO_ELECTION");
        let ok = stake >= threshold && stake > 0 && env::block_timestamp() <= election.candidacy_end.0 && !self.candidates.contains(&(id, account.clone()));
        if ok {
            election.candidates.push(account.clone());
            self.candidates.insert((id, account));
        } else {
            log!("{} can't stand: needs {} staked during candidacy", account, threshold);
        }
        ok
    }

    /// Votes for up to `council_size` candidates in election `id`, each
    /// getting the caller's whole stake at the election's start.
    pub fn vote_in_election(&mut self, id: u64, candidates: Vec<AccountId>) -> Promise {
        let size = usize::from(self.delegate_rules().council_size);
        let election = self.elections.get(&id).expect("ERR_NO_ELECTION");
        let now = env::block_timestamp();
        require!(now > election.candidacy_end.0, "ERR_ELECTION_NOT_VOTING");
        require!(now <= election.voting_end.0, "ERR_ELECTION_CLOSED");
        require!(!candidates.is_empty() && candidates.len() <= size, "ERR_TOO_MANY_CANDIDATES");
        for (i, c) in candidates.iter().enumerate() {
            require!(self.candidates.contains(&(id, c.clone())), "ERR_NOT_A_CANDIDATE");
            require!(!candidates[i + 1..].contains(c), "ERR_DUPLICATE_CANDIDATE");
        }
        let voter = env::predecessor_account_id();
        require!(!self.election_voters.contains_key(&(id, voter.clone())), "ERR_ALREADY_VOTED");
        self.election_voters.insert((id, voter.clone()), true);
        let snapshot = election.snapshot.0;
        self.weights_at(&voter, snapshot).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_election_weight(id, voter, candidates),
        )
    }

    #[private]
    pub fn on_election_weight(&mut self, id: u64, voter: AccountId, candidates: Vec<AccountId>) -> U128 {
        let weight = callback_value::<(U128, U128)>().map_or(0, |(own, _)| own.0);
        if weight == 0 {
            self.election_voters.remove(&(id, voter));
            return U128(0);
        }
        for c in candidates {
            *self.election_votes.entry((id, c)).or_insert(0) += weight;
        }
        self.election_voters.insert((id, voter), false);
        U128(weight)
    }

    /// Seats the top `council_size` candidates of election `id` for a new
    /// term. Ties keep the earlier candidate; empty seats stay empty.
    pub fn finalize_election(&mut self, id: u64) -> Vec<AccountId> {
        let rules = self.delegate_rules().clone();
        let election = self.elections.get(&id).cloned().expect("ERR_NO_ELECTION");
        require!(env::block_timestamp() > election.voting_end.0, "ERR_ELECTION_NOT_OVER");
        require!(!election.finalized, "ERR_ELECTION_FINALIZED");
        let mut ranked: Vec<(usize, AccountId, u128)> = election
            .candidates
            .iter()
            .enumerate()
            .map(|(i, c)| (i, c.clone(), self.election_votes.get(&(id, c.clone())).copied().unwrap_or(0)))
            .collect();
        ranked.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
        self.council = ranked.into_iter().take(usize::from(rules.council_size)).map(|(_, c, _)| c).collect();
        self.term_end = env::block_timestamp() + rules.term_length.0;
        self.elections.get_mut(&id).unwrap().finalized = true;
        self.council.clone()
    }

    // --- Delegate: recalls ---

    /// Starts a recall vote on council member `member`, if the caller's
    /// current stake meets the candidacy threshold. Returns the recall id.
    pub fn initiate_recall(&mut self, member: AccountId) -> Promise {
        self.delegate_rules();
        require!(self.council.contains(&member), "ERR_NOT_COUNCIL_MEMBER");
        let account = env::predecessor_account_id();
        self.current_stake(&account).then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_recall_stake(member, account))
    }

    #[private]
    pub fn on_recall_stake(&mut self, member: AccountId, initiator: AccountId) -> Option<u64> {
        let rules = self.delegate_rules().clone();
        let stake = callback_value::<(U128, U128)>().map_or(0, |(own, _)| own.0);
        if stake == 0 || stake < rules.candidacy_threshold.0 || !self.council.contains(&member) {
            log!("{} can't start a recall: needs {} staked", initiator, rules.candidacy_threshold.0);
            return None;
        }
        let now = env::block_timestamp();
        let id = self.recall_count;
        self.recalls.insert(
            id,
            Recall {
                member,
                end: U64(now + rules.recall_period.0),
                snapshot: U64(now),
                for_votes: U128(0),
                against_votes: U128(0),
                abstain_votes: U128(0),
                total: None,
                finalized: false,
                removed: false,
            },
        );
        self.recall_count += 1;
        Some(id)
    }

    /// Votes on recall `id` with the caller's stake at its start.
    pub fn vote_recall(&mut self, id: u64, choice: Choice) -> Promise {
        let recall = self.recalls.get(&id).expect("ERR_NO_RECALL");
        require!(env::block_timestamp() <= recall.end.0 && !recall.finalized, "ERR_RECALL_CLOSED");
        let voter = env::predecessor_account_id();
        require!(!self.recall_voters.contains_key(&(id, voter.clone())), "ERR_ALREADY_VOTED");
        self.recall_voters.insert((id, voter.clone()), true);
        let snapshot = recall.snapshot.0;
        self.weights_at(&voter, snapshot).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_recall_weight(id, voter, choice),
        )
    }

    #[private]
    pub fn on_recall_weight(&mut self, id: u64, voter: AccountId, choice: Choice) -> U128 {
        let Some((own, total)) = callback_value::<(U128, U128)>().filter(|(own, _)| own.0 > 0) else {
            self.recall_voters.remove(&(id, voter));
            return U128(0);
        };
        let recall = self.recalls.get_mut(&id).expect("ERR_NO_RECALL");
        recall.total.get_or_insert(total);
        let tally = match choice {
            Choice::For => &mut recall.for_votes,
            Choice::Against => &mut recall.against_votes,
            Choice::Abstain => &mut recall.abstain_votes,
        };
        tally.0 += own.0;
        self.recall_voters.insert((id, voter), false);
        own
    }

    /// Ends recall `id`; removes the member if the vote met the recall
    /// quorum and approval. Their seat stays empty until the next election.
    pub fn finalize_recall(&mut self, id: u64) -> bool {
        let rules = self.delegate_rules().clone();
        let recall = self.recalls.get_mut(&id).expect("ERR_NO_RECALL");
        require!(env::block_timestamp() > recall.end.0, "ERR_RECALL_NOT_OVER");
        require!(!recall.finalized, "ERR_RECALL_FINALIZED");
        recall.finalized = true;
        let total = recall.total.map_or(0, |t| t.0);
        let passed = passes(recall.for_votes.0, recall.against_votes.0, recall.abstain_votes.0, total, rules.recall_quorum_bps, rules.recall_approval_bps);
        if passed {
            let member = recall.member.clone();
            if let Some(i) = self.council.iter().position(|m| m == &member) {
                recall.removed = true;
                self.council.remove(i);
            }
        }
        recall.removed
    }

    // --- Sortition ---

    /// Enters the caller into the pool, if their current stake meets the threshold.
    pub fn register_eligible(&mut self) -> Promise {
        self.sortition_rules();
        let account = env::predecessor_account_id();
        require!(!self.pool_members.contains(&account), "ERR_ALREADY_ELIGIBLE");
        self.current_stake(&account).then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_eligible_stake(account))
    }

    #[private]
    pub fn on_eligible_stake(&mut self, account: AccountId) -> bool {
        let threshold = self.sortition_rules().eligibility_threshold.0;
        let stake = callback_value::<(U128, U128)>().map_or(0, |(own, _)| own.0);
        if stake == 0 || stake < threshold || self.pool_members.contains(&account) {
            log!("{} can't join the pool: needs {} staked", account, threshold);
            return false;
        }
        self.pool.push(account.clone());
        self.pool_members.insert(account);
        true
    }

    pub fn withdraw_eligibility(&mut self) {
        let account = env::predecessor_account_id();
        require!(self.pool_members.remove(&account), "ERR_NOT_ELIGIBLE");
        let index = (0..self.pool.len()).find(|&i| self.pool[i] == account).unwrap();
        self.pool.swap_remove(index);
    }

    /// Draws a new council from the pool once the term has ended.
    pub fn draw(&mut self) -> Vec<AccountId> {
        let rules = self.sortition_rules().clone();
        let now = env::block_timestamp();
        require!(now >= self.term_end, "ERR_TERM_NOT_OVER");
        let mut pool: Vec<AccountId> = self.pool.iter().cloned().collect();
        require!(!pool.is_empty(), "ERR_EMPTY_POOL");
        let seed = env::random_seed();
        let seats = usize::from(rules.council_size).min(pool.len());
        // Partial Fisher-Yates shuffle, with randomness stretched from the block seed.
        for i in 0..seats {
            let mut input = seed.clone();
            input.extend_from_slice(&(i as u64).to_le_bytes());
            let r = env::sha256_array(&input);
            let r = u64::from_le_bytes(r[..8].try_into().unwrap()) as usize;
            let j = i + r % (pool.len() - i);
            pool.swap(i, j);
        }
        pool.truncate(seats);
        self.council = pool;
        self.term_end = now + rules.term_length.0;
        self.council.clone()
    }

    // --- Views ---

    pub fn get_council(&self) -> Vec<AccountId> {
        self.council.clone()
    }

    pub fn get_term_end(&self) -> U64 {
        U64(self.term_end)
    }

    pub fn get_election_count(&self) -> u64 {
        self.election_count
    }

    /// Election `id` with each candidate's votes so far.
    pub fn get_election(&self, id: u64) -> Option<(Election, Vec<(AccountId, U128)>)> {
        self.elections.get(&id).map(|e| {
            let votes = e.candidates.iter().map(|c| (c.clone(), U128(self.election_votes.get(&(id, c.clone())).copied().unwrap_or(0)))).collect();
            (e.clone(), votes)
        })
    }

    pub fn get_recall_count(&self) -> u64 {
        self.recall_count
    }

    pub fn get_recall(&self, id: u64) -> Option<Recall> {
        self.recalls.get(&id).cloned()
    }

    pub fn get_pool(&self) -> Vec<AccountId> {
        self.pool.iter().cloned().collect()
    }
}

impl Contract {
    /// Council vote: one seat, one vote, counted at once.
    pub(crate) fn council_vote(&mut self, id: u64, choice: Choice) -> ballot::VoteOutcome {
        let voter = env::predecessor_account_id();
        require!(self.council.contains(&voter), "ERR_NOT_COUNCIL_MEMBER");
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Active, "ERR_PROPOSAL_NOT_ACTIVE");
        require!(!self.receipts.contains_key(&(id, voter.clone())), "ERR_ALREADY_VOTED");
        self.receipts.insert((id, voter), Receipt { choice, weight: U128(1), pending: false, via: None });
        let proposal = self.proposals.get_mut(&id).unwrap();
        match choice {
            Choice::For => proposal.for_ += 1,
            Choice::Against => proposal.against += 1,
            Choice::Abstain => proposal.abstain += 1,
        }
        proposal.voters += 1;
        let state = self.state(self.proposals.get(&id).unwrap());
        ballot::VoteOutcome { counted: true, weight: U128(1), state }
    }

    /// The caller's current stake: everything staked before the next block.
    fn current_stake(&self, account: &AccountId) -> Promise {
        self.weights_at(account, env::block_timestamp() + 1)
    }

    fn delegate_rules(&self) -> &DelegateRules {
        match &self.model {
            Model::Delegate(d) => d,
            _ => env::panic_str("ERR_NOT_DELEGATE"),
        }
    }

    fn sortition_rules(&self) -> &SortitionRules {
        match &self.model {
            Model::Sortition(s) => s,
            _ => env::panic_str("ERR_NOT_SORTITION"),
        }
    }
}
