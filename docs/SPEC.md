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
3. When the vote passes, anyone calls `finalize` on the orbit. It calls the
   core's `add_proposal` and, in the callback with the new id,
   `act_proposal(id, "VoteApprove", kind)`. With the 1-of-1 threshold,
   Sputnik executes at once.
4. A failed vote never reaches the core.

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
- **Open proposals in the old orbit are lost.** The old orbit refuses a swap
  while other proposals are open.
- **Optional guardian.** A DAO may add a second role (for example a small
  multisig) with only `policy_add_or_update_role:*` permissions, to recover
  from a broken orbit. Chosen per DAO at creation.

## Orbit interface

Every orbit implements:

| Method | Kind | Notes |
| --- | --- | --- |
| `new(dao_id, config)` | init | Binds the orbit to one core, for good |
| `propose(description, kind)` | change | `kind` is a Sputnik `ProposalKind` as JSON |
| `vote(id, choice)` | change | Rules are the orbit's own |
| `finalize(id)` | change | Sends a passed proposal to the core; marks a failed one rejected |
| `get_dao()` | view | Used by the swap check |
| `get_config()` | view | |
| `get_proposal(id)`, `get_proposals(from, limit)` | view | Status, tallies, and the core's proposal id once sent |

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
- Change to `sputnik-staking`: let the core change the owner, so stakes
  survive a swap away from and back to token weight.

## Global contracts and cost

The official Sputnik factory (3.2 and later) creates each DAO from a global
contract by code hash. Orbits does the same for its own contracts: each orbit,
the staking contract and the NEP-141 token are published once as global
contracts, and each DAO gets instances that reference them by hash. Code
referenced by hash can't change under a DAO; upgrades go through a swap.

| DAO | Cost to create (mainnet, approx.) |
| --- | --- |
| Native council | ~0.025 NEAR |
| Token weight | ~0.1 NEAR, plus ~0.00125 NEAR storage per member |

Plus a one-off cost to publish each global contract (10× normal storage).
Check the live factory's version with `get_contracts_metadata`; see
`docs/testnet-check.md`.
