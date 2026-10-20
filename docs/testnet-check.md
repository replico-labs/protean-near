# Testnet check

`orbits/core-tests` already checks the core policy against Sputnik's code.
These commands repeat the check on testnet against the live factory, with a
plain account standing in for the orbit. They use
[near-cli-rs](https://near.cli.rs) and haven't been run yet.

Replace `you.testnet` with your account and `orbit1.testnet` /
`orbit2.testnet` with two more accounts you control.

## 0. Protocol version

The Orbits contracts are built with near-sdk 5.29, which needs protocol 84
or later (nearcore 2.12). Check the network first:

```bash
curl -s https://rpc.testnet.near.org/status | jq .protocol_version
```

## 1. Factory version

```bash
near contract call-function as-read-only sputnikv2.testnet get_contracts_metadata \
  json-args '{}' network-config testnet now
```

Expect the default version to be `[3, 2]` or later (global contracts).

## 2. Create a DAO whose only member is the orbit

```bash
ARGS=$(cat <<'EOF' | base64 -w0
{"config":{"name":"orbits-check","purpose":"Orbits core check","metadata":""},
 "policy":{"roles":[{"name":"governance","kind":{"Group":["orbit1.testnet"]},
  "permissions":["*:AddProposal","*:VoteApprove","*:VoteReject","*:VoteRemove","*:Finalize"],
  "vote_policy":{}}],
  "default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,1]},
  "proposal_bond":"0","proposal_period":"604800000000000",
  "bounty_bond":"0","bounty_forgiveness_period":"86400000000000"}}
EOF
)
near contract call-function as-transaction sputnikv2.testnet create \
  json-args "{\"name\":\"orbits-check\",\"args\":\"$ARGS\"}" \
  prepaid-gas '150.0 Tgas' attached-deposit '0.5 NEAR' \
  sign-as you.testnet network-config testnet sign-with-keychain send
```

On macOS use `base64` without `-w0`. Expect `orbits-check.sputnikv2.testnet`
to exist. Note how much of the deposit stays on it.

## 3. The orbit's vote executes a transfer

```bash
DAO=orbits-check.sputnikv2.testnet
near contract call-function as-transaction $DAO add_proposal \
  json-args '{"proposal":{"description":"pay","kind":{"Transfer":{"token_id":"","receiver_id":"you.testnet","amount":"10000000000000000000000"}}}}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  sign-as orbit1.testnet network-config testnet sign-with-keychain send
# use the id it returns (0 for the first proposal)
near contract call-function as-transaction $DAO act_proposal \
  json-args '{"id":0,"action":"VoteApprove","proposal":{"Transfer":{"token_id":"","receiver_id":"you.testnet","amount":"10000000000000000000000","msg":null}}}' \
  prepaid-gas '150.0 Tgas' attached-deposit '0 NEAR' \
  sign-as orbit1.testnet network-config testnet sign-with-keychain send
```

Expect proposal 0 to be `Approved` (`get_proposal '{"id":0}'`) and 0.01 NEAR
to arrive at `you.testnet`.

## 4. Outsiders are refused

Run the `add_proposal` above signed by `you.testnet`. Expect
`ERR_PERMISSION_DENIED`.

## 5. Swap to a new orbit

```bash
ROLE='{"name":"governance","kind":{"Group":["orbit2.testnet"]},"permissions":["*:AddProposal","*:VoteApprove","*:VoteReject","*:VoteRemove","*:Finalize"],"vote_policy":{}}'
near contract call-function as-transaction $DAO add_proposal \
  json-args "{\"proposal\":{\"description\":\"swap\",\"kind\":{\"ChangePolicyAddOrUpdateRole\":{\"role\":$ROLE}}}}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  sign-as orbit1.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction $DAO act_proposal \
  json-args "{\"id\":1,\"action\":\"VoteApprove\",\"proposal\":{\"ChangePolicyAddOrUpdateRole\":{\"role\":$ROLE}}}" \
  prepaid-gas '150.0 Tgas' attached-deposit '0 NEAR' \
  sign-as orbit1.testnet network-config testnet sign-with-keychain send
```

Expect `get_policy` to show `orbit2.testnet` as the only member, and a new
`add_proposal` from `orbit1.testnet` to fail with `ERR_PERMISSION_DENIED`.
