# sputnik-staking (unmodified)

Copied from [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract)
at commit `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`, under its MIT licence
(`LICENSE`). Only `Cargo.toml` changed: the dev-dependency on Sputnik's test
token became `near-sdk` with unit testing, since that crate isn't copied.

Orbits deploys it with a token-weight orbit as its owner (`owner_id`): the
staking contract reports every delegation to the orbit, which implements
the same hooks a Sputnik DAO does.
