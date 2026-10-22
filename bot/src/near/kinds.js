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

const TGAS = 1_000_000_000_000n;

/**
 * Calls contract `receiver` from the treasury: `actions` are { method, args,
 * deposit (yoctoNEAR), tgas }, run in order in one batch.
 */
export function functionCall(receiver, actions) {
  return {
    FunctionCall: {
      receiver_id: receiver,
      actions: actions.map((a) => ({
        method_name: a.method,
        args: Buffer.from(JSON.stringify(a.args ?? {})).toString("base64"),
        deposit: String(a.deposit ?? 0n),
        gas: String(BigInt(a.tgas ?? 30) * TGAS),
      })),
    },
  };
}

/**
 * Swaps on Rhea: sends `amountIn` of `tokenIn` to the exchange `rhea` with
 * `route`, Rhea's swap actions; the last one carries the minimum the DAO
 * accepts, and the swap reverts below it. Rhea sends the output back to the
 * DAO. NEAR is wrapped first through `wrapNear`, in the same proposal.
 */
export function rheaSwap({ rhea, wrapNear, tokenIn, amountIn, route }) {
  const transfer = {
    method: "ft_transfer_call",
    args: { receiver_id: rhea, amount: String(amountIn), msg: JSON.stringify({ actions: route }) },
    deposit: 1n,
    tgas: 150,
  };
  if (tokenIn !== "NEAR") return functionCall(tokenIn, [transfer]);
  return functionCall(wrapNear, [{ method: "near_deposit", deposit: amountIn, tgas: 10 }, transfer]);
}

/** Stakes `amount` yoctoNEAR of the treasury with liquid staking contract `lst`, for its token. */
export function liquidStake(lst, amount) {
  return functionCall(lst, [{ method: "deposit_and_stake", deposit: amount, tgas: 50 }]);
}

/** Starts unstaking `amount` yoctoNEAR from `lst`; it can be withdrawn after about four epochs. */
export function liquidUnstake(lst, amount) {
  return functionCall(lst, [{ method: "unstake", args: { amount: String(amount) }, tgas: 75 }]);
}

/** Withdraws everything `lst` has finished unstaking back to the treasury. `method` differs by protocol. */
export function liquidWithdraw(lst, method) {
  return functionCall(lst, [{ method, tgas: 75 }]);
}

/**
 * Funds a NEAR Intents quote: deposits `amount` of `token` ("NEAR" is
 * wrapped first, in the same proposal) into `depositAddress`, the quote's
 * account inside NEAR Intents (`intents`). Solvers then fill the quote.
 */
export function intentsDeposit({ intents, wrapNear, token, amount, depositAddress }) {
  const deposit = {
    method: "ft_transfer_call",
    args: { receiver_id: intents, amount: String(amount), msg: depositAddress },
    deposit: 1n,
    tgas: 80,
  };
  if (token !== "NEAR") return functionCall(token, [deposit]);
  return functionCall(wrapNear, [{ method: "near_deposit", deposit: amount, tgas: 10 }, deposit]);
}

/** Withdraws `amount` of NEP-141 `token` from the DAO's NEAR Intents account to `receiver` (the treasury). */
export function intentsWithdraw({ intents, token, amount, receiver }) {
  return functionCall(intents, [{ method: "ft_withdraw", args: { token, receiver_id: receiver, amount: String(amount) }, deposit: 1n, tgas: 60 }]);
}

/** The JSON a FunctionCall action was sent with, or null. */
function callArgs(action) {
  try {
    return JSON.parse(Buffer.from(action.args ?? "", "base64").toString());
  } catch {
    return null;
  }
}

/** The tokens a kind moves, so their names and decimals can be loaded before describing it. */
export function kindTokens(kind) {
  const body = kind?.Transfer ?? kind?.FunctionCall;
  if (!body) return [];
  if (kind.Transfer) return body.token_id ? [body.token_id] : [];
  const swap = describeSwap(body);
  if (swap) return [swap.tokenIn, swap.tokenOut].filter((t) => t !== "NEAR");
  const deposit = describeIntentsDeposit(body);
  if (deposit) return deposit.token === "NEAR" ? [] : [deposit.token];
  const withdraw = body.actions[0]?.method_name === "ft_withdraw" && callArgs(body.actions[0]);
  return withdraw ? [withdraw.token] : [];
}

/** A NEAR Intents deposit, decoded: the token and amount, and the account inside NEAR Intents it funds; or null. */
export function describeIntentsDeposit(body) {
  const transfer = body.actions.find((a) => a.method_name === "ft_transfer_call");
  const args = transfer && callArgs(transfer);
  // A plain account as the message credits that account inside NEAR Intents.
  if (!args || !/^[a-z0-9_\-.]{2,64}$/.test(args.msg ?? "")) return null;
  const wrapped = body.actions[0]?.method_name === "near_deposit";
  return { intents: args.receiver_id, token: wrapped ? "NEAR" : body.receiver_id, amount: args.amount, depositAddress: args.msg };
}

/** A Rhea swap's tokens and amounts, decoded from its FunctionCall, or null. */
function describeSwap(body) {
  const transfer = body.actions.find((a) => a.method_name === "ft_transfer_call");
  const args = transfer && callArgs(transfer);
  let route;
  try {
    route = JSON.parse(args?.msg ?? "").actions;
  } catch {
    return null;
  }
  if (!Array.isArray(route) || !route.length) return null;
  const wrapped = body.actions[0]?.method_name === "near_deposit";
  return {
    exchange: args.receiver_id,
    tokenIn: wrapped ? "NEAR" : body.receiver_id,
    amountIn: args.amount,
    tokenOut: route.at(-1).token_out,
    minOut: route.at(-1).min_amount_out,
  };
}

function describeCall(body, { formatNear = String, formatToken = (id, amount) => `${amount} of ${id}` }) {
  const amount = (token, value) => (token === "NEAR" ? `${formatNear(value)} NEAR` : formatToken(token, value));
  const swap = describeSwap(body);
  if (swap) return `Swap ${amount(swap.tokenIn, swap.amountIn)} for at least ${amount(swap.tokenOut, swap.minOut)} on Rhea (${swap.exchange})`;
  const deposit = describeIntentsDeposit(body);
  if (deposit) return `Send ${amount(deposit.token, deposit.amount)} into NEAR Intents to fill quote ${deposit.depositAddress.slice(0, 10)}…`;
  const [first] = body.actions;
  const at = body.receiver_id;
  switch (first?.method_name) {
    case "deposit_and_stake":
      return `Liquid-stake ${formatNear(first.deposit)} NEAR with ${at}`;
    case "unstake":
      return `Unstake ${formatNear(callArgs(first)?.amount ?? "0")} NEAR from ${at} (withdrawable in about 4 epochs)`;
    case "sign": {
      const n = body.actions.filter((a) => a.method_name === "sign").length;
      return `Sign ${n} transaction${n === 1 ? "" : "s"} with the DAO's own EVM key (Chain Signatures, ${at}); the bot sends them once signed`;
    }
    case "ft_withdraw": {
      const args = callArgs(first) ?? {};
      return `Withdraw ${formatToken(args.token, args.amount)} from NEAR Intents to ${args.receiver_id}`;
    }
    case "withdraw_all":
    case "withdraw_unstaked":
      return `Withdraw unstaked NEAR from ${at}`;
    default:
      return `Call ${body.actions.map((a) => a.method_name).join(", ")} on ${at}`;
  }
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
    case "FunctionCall":
      return describeCall(body, { formatNear, formatToken });
    case "ChangePolicyAddOrUpdateRole":
      return body.role?.name === "governance"
        ? `Swap governance to ${body.role.kind?.Group?.[0]}`
        : `Change the "${body.role?.name}" role`;
    default:
      return name ?? "Unknown action";
  }
}
