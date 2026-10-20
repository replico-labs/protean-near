# Orbits — design spec

Orbits is a modular NEAR governance framework that provides interchangeable
governance modules for Sputnik DAO, for building and evolving onchain
organizations. Communities can swap their governance model by proposal
without moving their treasury.

## Terms

- **Core** — an unmodified Sputnik DAO created through the official factory
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
2. Users vote in the orbit under its rules (`vote`).
3. The vote that passes it sends it to the core when enough gas is attached;
   otherwise anyone calls `execute`. The orbit calls the core's
   `add_proposal` and, in the callback with the new id,
   `act_proposal(id, "VoteApprove", kind)`. With the 1-of-1 threshold,
   Sputnik executes at once.
4. A rejected or expired vote never reaches the core.

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

## Orbit interface

Every orbit implements:

| Method | Kind | Notes |
| --- | --- | --- |
| `new(dao_id, …)` | init | Binds the orbit to one core, for good |
| `propose(description, kind)` | change | `kind` is a Sputnik `ProposalKind` as JSON. Refused if it would lock the core (below) |
| `vote(id, choice)` | change | Rules are the orbit's own |
| `execute(id)` | change | Sends a passed proposal to the core and approves it there |
| `finalize(id)` | change | Marks a proposal whose voting period is over as expired |
| `get_dao()` | view | Used by the swap check |
| `get_config()` | view | |
| `get_proposal(id)`, `get_proposals(from, limit)`, `get_proposal_count()` | view | Status, tallies, and the core's proposal id once sent |

Statuses: `InProgress`, `Passed` (not yet on the core), `Executed` (approved
on the core; the core's own proposal status shows the execution result),
`Rejected`, `Expired`.

### Proposals an orbit refuses

`orbit-common` checks every proposal kind before anyone votes on it. It
refuses kinds that would leave the core with no working governance:
replacing the whole policy or the default vote policy; removing the
`governance` role or changing its members except by a swap; a swap that
changes the role's permissions or names more than one orbit; and policy
parameters that set a proposal bond or a proposal period under an hour.
Other roles (for example a guardian) may change freely.

## Orbits planned

| Orbit | Rules | Source |
| --- | --- | --- |
| Native council | No orbit: humans are the core's members directly. The free default, and Sputnik's own multisig | Sputnik as-is |
| Token weight | Staked tokens, with delegation | Logic from Sputnik's `policy.rs`, `proposals.rs`, `delegation.rs` |
| Quadratic, optimistic, conviction, … | Ported from Spaces / Vortexes | Protean |

The Social Money track asks teams not to rebuild the multisig, so there is no
board orbit: a board DAO is a native-council core.

## Token weight

NEAR has no synchronous reads between contracts, so the orbit can't check a
balance at vote time. As in Sputnik:

- Users stake through a `sputnik-staking` instance whose **owner is the
  orbit**. The staking contract pushes `register_delegation`, `delegate` and
  `undelegate` to its owner.
- The unstake cooldown must be longer than the voting period, so a stake
  can't vote twice.
- `sputnik-staking` is used unmodified: the orbit implements the same three
  hooks a Sputnik DAO does. Its owner is fixed at creation, so swapping away
  from token weight and back means a new staking contract, and members
  restake.
- Like Sputnik, the threshold is a share of all staked weight at the time of
  each vote, never less than 1, and a vote counts the voter's weight at the
  time they vote.

## Global contracts and cost

Every implementation is published once as a NEAR global contract, by code
hash (`bot/scripts/publish-contracts.js`, hashes in
`orbits/deployments/<network>.json`). Each DAO's orbit, token and staking
accounts use that code by hash and store none of their own, as the official
Sputnik factory (3.2 and later) does for the core. Code referenced by hash
can't change under a DAO: a new version is a new hash, and a DAO moves to it
by swapping orbits.

| | Cost |
| --- | --- |
| Publish the orbit, token and staking contract (once per network) | ~51 NEAR: 514 kB at 10× normal storage |
| Each token-weight DAO (`bot/scripts/deploy-dao.js`) | ~0.4 NEAR: the core's 0.1 NEAR deposit (mostly kept in its treasury), state funding for three accounts, and registrations |
| Each member who stakes | ~0.01 NEAR staking registration, paid from their account |

Check the live factory's version with `get_contracts_metadata` (3.2 or later
uses global contracts); see `docs/testnet-check.md`.
