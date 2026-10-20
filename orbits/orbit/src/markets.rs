//! Decision markets (futarchy), as in Spaces: each proposal gets a pass
//! market and a fail market, and whichever prices the DAO's token higher
//! over the trading window, by time-weighted average, decides.
//!
//! Spaces deploys conditional-token vaults and Uniswap V2 pairs; here they
//! are internal balances in the orbit. The base asset is the DAO's token,
//! the quote asset is NEAR (so nothing needs wrapping). Splitting one unit
//! of either gives one pass unit and one fail unit; after the window, only
//! the winning side's units redeem, one for one.
//!
//! 1. The proposer seeds both assets: NEAR with `seed_near`, the token with
//!    `{"seed": id}`. Once both are in, each market opens with the whole
//!    seed as liquidity and trading starts.
//! 2. Anyone splits assets (`split_near`, `{"split": id}`) and trades pass
//!    or fail units in either market (`trade`), Uniswap V2 pricing with a
//!    0.3% fee. `merge` turns a matched pass + fail pair back into the asset
//!    while trading is open.
//! 3. After the window the verdict is fixed: passed if the pass market's
//!    TWAP (NEAR per token) beats the fail market's by `threshold_bps`.
//!    `redeem` pays out winning units; `reclaim_liquidity` returns the
//!    seed's winning side to the proposer.

use super::*;

uint::construct_uint! {
    /// 256-bit integers, for prices and cumulative prices.
    pub struct U256(4);
}

/// Prices are NEAR (yocto) per raw token unit, scaled by 10^18.
const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Side {
    Pass,
    Fail,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Asset {
    /// The DAO's token.
    Token,
    Near,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pool {
    pub token: U128,
    pub near: U128,
    /// Sum of price × seconds since the market opened (decimal string of a 256-bit integer).
    pub cumulative: String,
    pub last: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Exchange {
    pub token_seed: U128,
    pub near_seed: U128,
    pub opened_at: Option<U64>,
    pub deadline: U64,
    pub pass: Pool,
    pub fail: Pool,
    pub reclaimed: bool,
}

/// An account's conditional units in one proposal's markets.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Holdings {
    pub pass_token: U128,
    pub fail_token: U128,
    pub pass_near: U128,
    pub fail_near: U128,
}

impl Pool {
    fn opened(token: u128, near: u128, now: u64) -> Self {
        Pool { token: U128(token), near: U128(near), cumulative: "0".into(), last: U64(now) }
    }

    fn price(&self) -> U256 {
        if self.token.0 == 0 {
            return U256::zero();
        }
        U256::from(self.near.0) * U256::from(PRICE_SCALE) / U256::from(self.token.0)
    }

    fn cumulative(&self) -> U256 {
        U256::from_dec_str(&self.cumulative).unwrap_or_default()
    }

    /// The cumulative price up to `t`, which never passes the deadline.
    fn cumulative_at(&self, t: u64) -> U256 {
        let seconds = t.saturating_sub(self.last.0) / 1_000_000_000;
        self.cumulative() + self.price() * U256::from(seconds)
    }

    fn accumulate(&mut self, t: u64) {
        let seconds = t.saturating_sub(self.last.0) / 1_000_000_000;
        if seconds > 0 {
            self.cumulative = self.cumulative_at(t).to_string();
            self.last = U64(self.last.0 + seconds * 1_000_000_000);
        }
    }
}

impl Exchange {
    /// TWAP of each market over the whole window.
    pub fn twaps(&self) -> (U256, U256) {
        let Some(opened) = self.opened_at else { return (U256::zero(), U256::zero()) };
        let seconds = U256::from(((self.deadline.0 - opened.0) / 1_000_000_000).max(1));
        (self.pass.cumulative_at(self.deadline.0) / seconds, self.fail.cumulative_at(self.deadline.0) / seconds)
    }

    /// The verdict: pass TWAP above fail TWAP by `threshold_bps`. Meaningful once trading is over.
    pub fn passed(&self, threshold_bps: u16) -> bool {
        let (pass, fail) = self.twaps();
        self.opened_at.is_some() && pass * U256::from(MAX_BPS) > fail * U256::from(MAX_BPS + threshold_bps)
    }
}

/// Uniswap V2: what `amount_in` buys from a pool with these reserves, after a 0.3% fee.
pub fn amount_out(amount_in: u128, reserve_in: u128, reserve_out: u128) -> u128 {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return 0;
    }
    let with_fee = U256::from(amount_in) * U256::from(997u32);
    let out = with_fee * U256::from(reserve_out) / (U256::from(reserve_in) * U256::from(1000u32) + with_fee);
    out.as_u128()
}

#[near]
impl Contract {
    /// The proposer seeds the NEAR side of their proposal's markets.
    #[payable]
    pub fn seed_near(&mut self, id: u64) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(proposal.proposer == env::predecessor_account_id(), "ERR_NOT_PROPOSER");
        require!(!proposal.cancelled, "ERR_PROPOSAL_CLOSED");
        let exchange = self.exchange_mut(id);
        require!(exchange.near_seed.0 == 0, "ERR_ALREADY_SEEDED");
        exchange.near_seed = U128(amount);
        self.open_if_seeded(id);
    }

    /// Splits the attached NEAR into pass and fail units.
    #[payable]
    pub fn split_near(&mut self, id: u64) {
        let amount = env::attached_deposit().as_yoctonear();
        self.split(id, env::predecessor_account_id(), Asset::Near, amount);
    }

    /// Turns `amount` matched pass + fail units back into the asset, while trading is open.
    pub fn merge(&mut self, id: u64, asset: Asset, amount: U128) {
        let account = env::predecessor_account_id();
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Active, "ERR_TRADING_CLOSED");
        let mut h = self.holdings.get(&(id, account.clone())).cloned().unwrap_or_default();
        let (pass, fail) = match asset {
            Asset::Token => (&mut h.pass_token, &mut h.fail_token),
            Asset::Near => (&mut h.pass_near, &mut h.fail_near),
        };
        require!(pass.0 >= amount.0 && fail.0 >= amount.0, "ERR_NOT_ENOUGH_UNITS");
        pass.0 -= amount.0;
        fail.0 -= amount.0;
        self.holdings.insert((id, account.clone()), h);
        self.pay(&account, asset, amount.0);
    }

    /// Sells `amount_in` of the caller's `side` units of `asset_in` in that
    /// side's market for the other asset's units. Returns what it bought.
    pub fn trade(&mut self, id: u64, side: Side, asset_in: Asset, amount_in: U128, min_out: U128) -> U128 {
        let account = env::predecessor_account_id();
        let now = env::block_timestamp();
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Active, "ERR_TRADING_CLOSED");
        let mut h = self.holdings.get(&(id, account.clone())).cloned().unwrap_or_default();
        let exchange = self.exchange_mut(id);
        let pool = match side {
            Side::Pass => &mut exchange.pass,
            Side::Fail => &mut exchange.fail,
        };
        pool.accumulate(now);
        let (held_in, held_out, reserve_in, reserve_out) = match (side, asset_in) {
            (Side::Pass, Asset::Token) => (&mut h.pass_token, &mut h.pass_near, &mut pool.token, &mut pool.near),
            (Side::Pass, Asset::Near) => (&mut h.pass_near, &mut h.pass_token, &mut pool.near, &mut pool.token),
            (Side::Fail, Asset::Token) => (&mut h.fail_token, &mut h.fail_near, &mut pool.token, &mut pool.near),
            (Side::Fail, Asset::Near) => (&mut h.fail_near, &mut h.fail_token, &mut pool.near, &mut pool.token),
        };
        require!(held_in.0 >= amount_in.0 && amount_in.0 > 0, "ERR_NOT_ENOUGH_UNITS");
        let out = amount_out(amount_in.0, reserve_in.0, reserve_out.0);
        require!(out > 0 && out >= min_out.0, "ERR_SLIPPAGE");
        held_in.0 -= amount_in.0;
        reserve_in.0 += amount_in.0;
        reserve_out.0 -= out;
        held_out.0 += out;
        self.holdings.insert((id, account), h);
        U128(out)
    }

    /// After trading, pays the caller's winning units one for one and clears their units.
    pub fn redeem(&mut self, id: u64) -> (U128, U128) {
        let account = env::predecessor_account_id();
        let passed = self.decided(id);
        let h = self.holdings.remove(&(id, account.clone())).expect("ERR_NOTHING_TO_REDEEM");
        let (token, near) = if passed { (h.pass_token.0, h.pass_near.0) } else { (h.fail_token.0, h.fail_near.0) };
        self.pay(&account, Asset::Token, token);
        self.pay(&account, Asset::Near, near);
        (U128(token), U128(near))
    }

    /// After trading, returns the winning market's reserves (the seed and
    /// what trading left in it) to the proposer. Once per proposal.
    pub fn reclaim_liquidity(&mut self, id: u64) -> (U128, U128) {
        let passed = self.decided(id);
        let proposer = self.proposals.get(&id).unwrap().proposer.clone();
        let exchange = self.exchange_mut(id);
        require!(!exchange.reclaimed, "ERR_RECLAIMED");
        exchange.reclaimed = true;
        let pool = if passed { &exchange.pass } else { &exchange.fail };
        let (token, near) = (pool.token.0, pool.near.0);
        self.pay(&proposer, Asset::Token, token);
        self.pay(&proposer, Asset::Near, near);
        (U128(token), U128(near))
    }

    pub fn get_exchange(&self, id: u64) -> Option<(Exchange, U128, U128)> {
        match &self.proposals.get(&id)?.market {
            Some(Market::Decision(e)) => {
                let (pass, fail) = e.twaps();
                let clamp = |v: U256| U128(if v > U256::from(u128::MAX) { u128::MAX } else { v.as_u128() });
                Some((e.clone(), clamp(pass), clamp(fail)))
            }
            _ => None,
        }
    }

    pub fn get_holdings(&self, id: u64, account_id: AccountId) -> Option<Holdings> {
        self.holdings.get(&(id, account_id)).cloned()
    }
}

impl Contract {
    fn exchange_mut(&mut self, id: u64) -> &mut Exchange {
        match &mut self.proposals.get_mut(&id).expect("ERR_NO_PROPOSAL").market {
            Some(Market::Decision(e)) => e,
            _ => env::panic_str("ERR_NOT_DECISION_MARKETS"),
        }
    }

    /// Whether the proposal passed; its trading window must be over.
    fn decided(&self, id: u64) -> bool {
        let Model::DecisionMarkets(rules) = &self.model else { env::panic_str("ERR_NOT_DECISION_MARKETS") };
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        let Some(Market::Decision(e)) = &proposal.market else { env::panic_str("ERR_NOT_DECISION_MARKETS") };
        require!(e.opened_at.is_some() && env::block_timestamp() >= e.deadline.0, "ERR_TRADING_NOT_OVER");
        e.passed(rules.threshold_bps)
    }

    /// Opens both markets once the proposer has seeded both assets.
    fn open_if_seeded(&mut self, id: u64) {
        let Model::DecisionMarkets(rules) = &self.model else { env::panic_str("ERR_NOT_DECISION_MARKETS") };
        let period = rules.trading_period.0;
        let now = env::block_timestamp();
        let exchange = self.exchange_mut(id);
        if exchange.token_seed.0 == 0 || exchange.near_seed.0 == 0 {
            return;
        }
        let (token, near) = (exchange.token_seed.0, exchange.near_seed.0);
        exchange.pass = Pool::opened(token, near, now);
        exchange.fail = Pool::opened(token, near, now);
        exchange.opened_at = Some(U64(now));
        exchange.deadline = U64(now + period);
        let p = self.proposals.get_mut(&id).unwrap();
        p.activated = true;
        p.start = now;
        p.end = now + period;
    }

    /// `{"seed": id}`: the proposer seeds the token side.
    pub(crate) fn seed_base(&mut self, id: u64, sender: AccountId, amount: u128) -> u128 {
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(proposal.proposer == sender, "ERR_NOT_PROPOSER");
        require!(!proposal.cancelled, "ERR_PROPOSAL_CLOSED");
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let exchange = self.exchange_mut(id);
        require!(exchange.token_seed.0 == 0, "ERR_ALREADY_SEEDED");
        exchange.token_seed = U128(amount);
        self.open_if_seeded(id);
        0
    }

    /// `{"split": id}`: splits tokens into pass and fail units.
    pub(crate) fn split_base(&mut self, id: u64, sender: AccountId, amount: u128) -> u128 {
        self.split(id, sender, Asset::Token, amount);
        0
    }

    fn split(&mut self, id: u64, account: AccountId, asset: Asset, amount: u128) {
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let proposal = self.proposals.get(&id).expect("ERR_NO_PROPOSAL");
        require!(self.state(proposal) == State::Active, "ERR_TRADING_CLOSED");
        let h = self.holdings.entry((id, account)).or_default();
        match asset {
            Asset::Token => {
                h.pass_token.0 += amount;
                h.fail_token.0 += amount;
            }
            Asset::Near => {
                h.pass_near.0 += amount;
                h.fail_near.0 += amount;
            }
        }
    }

    fn pay(&self, receiver: &AccountId, asset: Asset, amount: u128) {
        match asset {
            Asset::Token => self.pay_token(receiver, amount),
            Asset::Near => self.transfer_near(receiver, amount),
        }
    }

    /// On cancel before the markets open: the seeds go back.
    pub(crate) fn refund_seeds(&mut self, id: u64) {
        let proposer = self.proposals.get(&id).unwrap().proposer.clone();
        let exchange = self.exchange_mut(id);
        if exchange.opened_at.is_some() {
            return;
        }
        let (token, near) = (exchange.token_seed.0, exchange.near_seed.0);
        exchange.token_seed = U128(0);
        exchange.near_seed = U128(0);
        self.pay(&proposer, Asset::Token, token);
        self.pay(&proposer, Asset::Near, near);
    }
}
