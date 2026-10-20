/**
 * Sputnik proposal kinds the bot proposes through an orbit. The orbit only
 * stores them and forwards them to the core, so they must be exactly what
 * Sputnik expects; orbits/core-tests decodes every one of these with
 * Sputnik's own types (see bot/test/fixtures).
 */

/** Pays `amount` (yoctoNEAR, a string) from the treasury to `receiver`. */
export function transferNear(receiver, amount) {
  return { Transfer: { token_id: "", receiver_id: receiver, amount: String(amount) } };
}

/** Pays `amount` (token units, a string) of NEP-141 token `tokenId` from the treasury. */
export function transferToken(tokenId, receiver, amount) {
  return { Transfer: { token_id: tokenId, receiver_id: receiver, amount: String(amount) } };
}

/** A decision with nothing to execute: a poll or a statement. */
export function signal() {
  return "Vote";
}

/** Hands the core to `newOrbit` (orbit_common::swap_kind). */
export function swap(newOrbit) {
  return {
    ChangePolicyAddOrUpdateRole: {
      role: {
        name: "governance",
        kind: { Group: [newOrbit] },
        permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
        vote_policy: {},
      },
    },
  };
}

/** A one-line, human description of `kind`. */
export function describeKind(kind, { formatNear, formatToken } = {}) {
  if (kind === "Vote") return "Signal vote (nothing is executed)";
  const [name, body] = Object.entries(kind ?? {})[0] ?? [];
  switch (name) {
    case "Transfer":
      return body.token_id
        ? `Pay ${formatToken ? formatToken(body.token_id, body.amount) : body.amount} of ${body.token_id} to ${body.receiver_id}`
        : `Pay ${formatNear ? formatNear(body.amount) : body.amount} NEAR to ${body.receiver_id}`;
    case "ChangePolicyAddOrUpdateRole":
      return body.role?.name === "governance"
        ? `Swap governance to ${body.role.kind?.Group?.[0]}`
        : `Change the "${body.role?.name}" role`;
    default:
      return name ?? "Unknown action";
  }
}
