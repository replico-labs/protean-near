# Orbits — design spec

Orbits is a modular NEAR governance framework that provides interchangeable
governance modules for Sputnik DAO, for building and evolving onchain
organizations. Communities can swap their governance model by proposal
without moving their treasury.

## Terms

- **Core** — an unmodified Sputnik DAO, created through Protean's own copy
  of Sputnik's factory (`bot/scripts/deploy-factory.js`, Sputnik 3.2, which
  shares the DAO code as a global contract) or an official one
  (`sputnikv2.testnet`, `sputnik-dao.near`). It holds the treasury and
  executes proposals.
- **Orbit** — a governance module contract. It holds proposals and votes
  under its own rules, and is the core's only voter.
- **Swap orbit** — the single proposal that hands control of the core from
  one orbit to another.

## The core policy

Every Orbits DAO is created with this policy. The only member is the orbit
account; it passes anything with its one vote.

```json
{
  "roles": [{
    "name": "governance",
    "kind": { "Group": ["<orbit account>"] },
    "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
    "vote_policy": {}
  }],
  "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1] },
  "proposal_bond": "0",
  "proposal_period": "604800000000000",
  "bounty_bond": "0",
  "bounty_forgiveness_period": "86400000000000"
}
```

- No `all` / `Everyone` role, unlike Sputnik's default policy: only the orbit
  can add proposals, so the core's proposal list holds only what governance
  passed.
- `proposal_bond` is 0 so the orbit doesn't attach NEAR to every proposal.
  Spam protection belongs in each orbit.
- `proposal_period` is 7 days (nanoseconds). The orbit adds a proposal to the
  core only after its own vote passes, so this only needs to cover the
  add-then-approve step.

Verified against Sputnik's own code by `orbits/core-tests`: the orbit's single
vote executes a proposal, outsiders can neither propose nor vote, the orbit
can reject, and a swap hands control to the new orbit and removes the old one.

## How a proposal flows

1. A user proposes in the orbit (`propose`). The orbit stores the Sputnik
   proposal kind (for example a `Transfer`) as JSON.
2. Members decide in the orbit under its model (`vote`, `support`, a
   challenge...).
3. Once it has passed and its timelock is over, anyone calls `execute`
   within the execution window. The orbit calls the core's `add_proposal`
   and, in the callback with the new id, `act_proposal(id, "VoteApprove",
   kind)`. With the 1-of-1 threshold, Sputnik executes at once.
4. A defeated, cancelled or expired proposal never reaches the core.

Only one send runs at a time, so the core can't receive the same proposal
twice. A send that fails part-way can be retried with `execute`: if the
proposal is already on the core, the retry only approves it there.

`act_proposal` takes the proposal `kind` as well as the id; the orbit passes
the kind it stored, so it must match exactly.

## Swapping orbits

A swap is one `ChangePolicyAddOrUpdateRole` proposal, passed by the current
orbit, that replaces the `governance` group `{old}` with `{new}`.

- **Never two proposals.** Removing the old orbit first leaves nobody able to
  approve adding the new one, and the DAO is locked for good.
- **Check the new orbit first.** Before approving, the old orbit calls the new
  orbit's `get_dao()` and approves only if it returns this core. A wrong or
  uninitialised address then fails safely.
- **Open proposals in the old orbit are lost.** After a swap, the old orbit's
  remaining proposals can't execute: the core no longer accepts its votes.
- **Optional guardian.** A DAO may add a second role (for example a small
  multisig) with only `policy_add_or_update_role:*` permissions, to recover
  from a broken orbit. Chosen per DAO at creation.

## The orbit modules

Each model is its own contract, an Orbits module (`orbits/modules/<model>`),
nine in all. A DAO's orbit is an instance of one module; switching models
means a swap to an orbit of another module.

The modules are built from one engine crate (`orbits/orbit`), where each
model is a Cargo feature and each module enables exactly one. A module's
contract therefore carries only its own model's methods, while the code
that matters most is written and tested once: sending a passed proposal to
the core exactly once, the swap check, and the proposal rules below. A
module refuses to be initialised with another model's settings.

| Method | Notes |
| --- | --- |
| `new(dao_id, staking_id, token_id, model, council)` | Binds the orbit to one core for good |
| `propose(description, kind)` | `kind` is a Sputnik `ProposalKind` as JSON. Council models: council members only. Otherwise a proposal threshold, if set, is checked against the proposer's stake |
| `vote(id, choice)` | For / Against / Abstain. Stake models read the voter's stake at the proposal's snapshot; councils count one vote per seat |
| `execute(id)` | Once passed (or queued) and past its timelock, within its execution window: sends it to the core and approves it there |
| `cancel(id)` | The proposer, before execution |
| `get_dao()`, `get_model()`, `get_proposal(id)`, `get_proposals(from, limit)` | Views; `get_dao` is what the swap check reads |

Model-specific methods: `delegate`, `undelegate`, `resolve_delegated_vote`
(liquid); `ft_on_transfer` with `{"challenge": id}` and `resolve_challenge`
(optimistic); `support`, `withdraw_support`, `queue` (conviction);
`start_election`, `declare_candidacy`, `vote_in_election`,
`finalize_election`, `initiate_recall`, `vote_recall`, `finalize_recall`
(delegate); `register_eligible`, `withdraw_eligibility`, `draw` (sortition).

States: `Pending`, `Active`, `ChallengeWindow` (optimistic), `Succeeded`,
`Defeated`, `Queued` (conviction), `Executed` (approved on the core),
`Expired`, `Cancelled`.

### Proposals an orbit refuses

`orbit-common` checks every proposal kind before anyone votes on it. It
refuses kinds that would leave the core with no working governance:
replacing the whole policy or the default vote policy; removing the
`governance` role or changing its members except by a swap; a swap that
changes the role's permissions or names more than one orbit; and policy
parameters that set a proposal bond or a proposal period under an hour.
Other roles (for example a guardian) may change freely.

## Models

The rules follow Protean's EVM contracts (Spaces). Times are nanoseconds,
shares basis points.

| Model | Rules |
| --- | --- |
| Board | No orbit: the members are the core's governance role and pass proposals by simple majority. Sputnik's own multisig |
| Token-weighted | Turnout (for + against + abstain) must reach `quorum_bps` of total stake at the snapshot, and for / (for + against) must reach `approval_bps` |
| Quadratic | As token-weighted, with each vote weighing the square root of stake and quorum measured against the square root of total stake |
| Liquid | As token-weighted; anyone may delegate. `resolve_delegated_vote` follows a delegator's chain (up to 5 hops) to the first account that voted and adds the delegator's stake to that choice |
| Optimistic | Passes when its challenge window ends unchallenged. A challenge sends `challenge_bond` of the token to the orbit and starts a token-weighted vote; the bond goes to the treasury if the proposal passes anyway, back to the challenger if it fails |
| Conviction | A member backs one proposal with all their unlocked stake, which the staking contract locks. Conviction moves linearly toward current support at `growth_per_second`; a proposal may queue once it reaches its requirement: `min_conviction`, plus a multiplier for NEAR or token payouts, or `governance_conviction` for anything else |
| Delegate | Stakers elect a council (plurality, top `council_size` win) for a term, and can recall a member by a stake-weighted vote. The council proposes and votes one seat, one vote |
| Sortition | As delegate, but the council is drawn at random from stakers who opted in. NEAR's block random seed replaces Spaces' Pyth Entropy: no oracle or fee, but the block producer could bias a draw |
| Sowellian | Approval is a stake-weighted vote on the proposal and its success criteria (an oracle value against a target, or a human resolver), gated by a proposal bond. Once approved, YES/NO positions in the token are taken for `positions_window`; then it executes, and after its measurement period the outcome is resolved: by the oracle, or by a bonded resolver whose answer may be disputed with a bond and adjudicated by stake at the end of approval. Winners share the whole pool; bonds follow who was right. If it never executes, positions are refunded |
| Decision markets | Each proposal gets a pass market and a fail market (constant-product, Uniswap V2 pricing with a 0.3% fee) trading the DAO's token against NEAR, seeded by the proposer. Units are internal balances: splitting gives equal pass and fail units. After `trading_period`, it passed if the pass market's time-weighted price beats the fail market's by `threshold_bps`; only winning units redeem, one for one |

Sowellian's oracle is any contract with `latest_value({"selector"})`
returning `[value, updated_at]`, the NEAR form of Spaces' IMetricOracle; no
adapter to a NEAR price feed is included yet. Tokens reach the orbit with
`ft_transfer_call` and a message saying what they're for (a bond, a
position, a seed), since NEAR has no `transferFrom`.

## Staking

Each DAO has one staking contract (`orbits/orbit-staking`), owned by its core,
not by an orbit:

- Members stake the token with `ft_transfer_call` and take it back with
  `unstake` at any time. Each change is a checkpoint; `weights_at(account,
  t)` returns stake and total stake strictly before `t`, so weight fixed at a
  proposal's snapshot can't be moved and used again.
- Because the staking contract belongs to the core, a new orbit reads the
  same stakes: switching models keeps every member's stake.
- The orbit governing the core can become the *locker* (`claim_locker`,
  checked against the core's policy). Conviction locks stake while it backs a
  proposal. Locks are kept per locker, so a replaced orbit can still release
  what it locked.
- Members pay for their own checkpoints from a NEAR balance deposited with
  `storage_deposit`.

## Global contracts and cost

The nine modules and the staking and token contracts are each published once as a NEAR
global contract, by code hash (`bot/scripts/publish-contracts.js`, hashes in
`orbits/deployments/<network>.json`). Each DAO's orbit, token and staking
accounts use that code by hash and store none of their own, as the official
Sputnik factory (3.2 and later) does for the core. Code referenced by hash
can't change under a DAO: a new version is a new hash, and a DAO moves to it
by swapping orbits.

| | Cost |
| --- | --- |
| Publish all nine modules, staking and token (once per network) | ~255 NEAR: 2.55 MB at 10× normal storage |
| ...or staking, token and one module | ~57 NEAR; each further module ~23-28 NEAR |
| Each DAO (`/createdao`) | ~0.6 NEAR through a 3.2 factory: the core's 0.1 NEAR deposit (mostly kept in its treasury), state funding for its accounts, and registrations. `sputnikv2.testnet` still stores the DAO code in each DAO and needs ~5.4 NEAR more |
| A model switch | ~0.25 NEAR for the new orbit |
| Each member who stakes | ~0.01 NEAR staking storage, paid from their account |

Check the live factory's version with `get_contracts_metadata` (3.2 or later
uses global contracts); see `docs/testnet-check.md`.
