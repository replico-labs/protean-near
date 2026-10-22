import * as kinds from "../src/near/kinds.js";
import { modelConfig, MODELS, orbitPolicy, boardPolicy } from "../src/near/models.js";

/** Every kind of proposal the bot makes, with sample values; what core-tests checks against Sputnik. */
export function kindFixtures() {
  return {
    transferNear: kinds.transferNear("maya.testnet", 1500000000000000000000000n),
    transferToken: kinds.transferToken("token.mydao.orbits.testnet", "maya.testnet", 250000000000000000000n),
    signal: kinds.signal(),
    swap: kinds.swap("q.mydao.orbits.testnet"),
    rheaSwapNear: kinds.rheaSwap({
      rhea: "ref-finance-101.testnet",
      wrapNear: "wrap.testnet",
      tokenIn: "NEAR",
      amountIn: 10n ** 24n,
      route: [{ pool_id: 7, token_in: "wrap.testnet", token_out: "usdc.testnet", amount_in: String(10n ** 24n), min_amount_out: "4950000" }],
    }),
    rheaSwapToken: kinds.rheaSwap({
      rhea: "ref-finance-101.testnet",
      wrapNear: "wrap.testnet",
      tokenIn: "token.mydao.orbits.testnet",
      amountIn: 500n * 10n ** 18n,
      route: [
        { pool_id: 3, token_in: "token.mydao.orbits.testnet", token_out: "wrap.testnet", amount_in: String(500n * 10n ** 18n), min_amount_out: "0" },
        { pool_id: 7, token_in: "wrap.testnet", token_out: "usdc.testnet", min_amount_out: "1000000" },
      ],
    }),
    liquidStake: kinds.liquidStake("linear-protocol.testnet", 5n * 10n ** 24n),
    liquidUnstake: kinds.liquidUnstake("linear-protocol.testnet", 2n * 10n ** 24n),
    liquidWithdraw: kinds.liquidWithdraw("meta-v2.pool.testnet", "withdraw_unstaked"),
    intentsDepositNear: kinds.intentsDeposit({ intents: "intents.near", wrapNear: "wrap.near", token: "NEAR", amount: 10n ** 24n, depositAddress: "c".repeat(64) }),
    intentsDepositToken: kinds.intentsDeposit({ intents: "intents.near", wrapNear: "wrap.near", token: "usdc.testnet", amount: 1_020_000n, depositAddress: "d".repeat(64) }),
    intentsWithdraw: kinds.intentsWithdraw({ intents: "intents.near", token: "usdc.testnet", amount: 1_000_000n, receiver: "mydao.sputnikv2.testnet" }),
  };
}

/** The orbit settings the bot creates for each model, for a 1,000,000-token supply; core-tests checks the orbit accepts them. */
export function modelFixtures() {
  const supply = 1_000_000n * 10n ** 18n;
  return Object.fromEntries(Object.keys(MODELS).filter((m) => m !== "board").map((m) => [m, modelConfig(m, supply, 3)]));
}

/** The Sputnik policies the bot creates DAOs with; core-tests creates a DAO with each. */
export function policyFixtures() {
  return { orbit: orbitPolicy("orbit1.testnet"), board: boardPolicy(["m1.testnet", "m2.testnet", "m3.testnet"]) };
}
