import * as kinds from "../src/near/kinds.js";

/** Every kind of proposal the bot makes, with sample values; what core-tests checks against Sputnik. */
export function kindFixtures() {
  return {
    transferNear: kinds.transferNear("maya.testnet", 1500000000000000000000000n),
    transferToken: kinds.transferToken("token.mydao.orbits.testnet", "maya.testnet", 250000000000000000000n),
    signal: kinds.signal(),
    swap: kinds.swap("q.mydao.orbits.testnet"),
  };
}
