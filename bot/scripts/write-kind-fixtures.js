import { writeFileSync } from "node:fs";
import { kindFixtures, modelFixtures, policyFixtures } from "../test/kindFixtures.js";

/**
 * Writes the fixtures orbits/core-tests checks against the contracts:
 * test/fixtures/kinds.json, every kind of proposal the bot makes, and
 * test/fixtures/models.json, the orbit settings it creates for each model, and
 * test/fixtures/policies.json, the Sputnik policies it creates DAOs with.
 * Run after changing src/near/kinds.js or src/near/models.js:
 *   node scripts/write-kind-fixtures.js
 */
const write = (name, data) => writeFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), JSON.stringify(data, null, 2) + "\n");
write("kinds.json", kindFixtures());
write("models.json", modelFixtures());
write("policies.json", policyFixtures());
