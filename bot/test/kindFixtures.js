import * as kinds from "../src/near/kinds.js";
import { modelConfig, MODELS, orbitPolicy, boardPolicy } from "../src/near/models.js";

/** Every kind of proposal the bot makes, with sample values; what core-tests checks against Sputnik. */
export function kindFixtures() {
  return {
    transferNear: kinds.transferNear("maya.testnet", 1500000000000000000000000n),
    transferToken: kinds.transferToken("token.mydao.orbits.testnet", "maya.testnet", 250000000000000000000n),
    signal: kinds.signal(),
    swap: kinds.swap("q.mydao.orbits.testnet"),
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
