// Creates a complete Orbits DAO from the command line; the same thing the
// bot's /createdao does, without a chat.
//
//   node scripts/deploy-dao.js <name> <SYMBOL> <supply> [model] [members...] [--holder <account>]
//
// Signs as NEAR_OPERATOR_ACCOUNT_ID (.env). Needs the contracts published
// once (scripts/publish-contracts.js --yes).
import "../src/logRedaction.js";
import { OPERATOR_ACCOUNT_ID, EXPLORER_URL } from "../src/config.js";
import { createDao } from "../src/near/deploy.js";
import { MODELS } from "../src/near/models.js";
import { toUnits } from "../src/near/amounts.js";

const argv = process.argv.slice(2);
const holderAt = argv.indexOf("--holder");
const holder = holderAt >= 0 ? argv.splice(holderAt, 2)[1] : OPERATOR_ACCOUNT_ID;
const [name, symbol, supply, model = "tokenWeighted", ...council] = argv;

if (!name || !symbol || !toUnits(supply, 18) || !MODELS[model]) {
  console.error(`Usage: node scripts/deploy-dao.js <name> <SYMBOL> <supply> [model] [members...] [--holder <account>]\nModels: ${Object.keys(MODELS).join(", ")}`);
  process.exit(1);
}

createDao({ name, symbol, supply: toUnits(supply, 18), model, council, holder, onStep: (s) => console.log(`${s}...`) })
  .then((dao) => {
    console.log(`\nDone: ${dao.daoId}${dao.orbitId ? ` governed by ${dao.orbitId}` : ""} (${model}). ${holder} holds all ${supply} ${symbol}.`);
    console.log(`Link a chat:  /link ${dao.daoId}${dao.orbitId ? ` ${dao.orbitId}` : ""}`);
    console.log(`Explorer:     ${EXPLORER_URL}/address/${dao.daoId}`);
  })
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
