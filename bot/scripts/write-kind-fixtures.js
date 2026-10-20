import { writeFileSync } from "node:fs";
import { kindFixtures } from "../test/kindFixtures.js";

/**
 * Writes test/fixtures/kinds.json: every kind of proposal the bot makes.
 * orbits/core-tests decodes each with Sputnik's own types and checks the
 * orbit accepts it. Run after changing src/near/kinds.js:
 *   node scripts/write-kind-fixtures.js
 */
writeFileSync(new URL("../test/fixtures/kinds.json", import.meta.url), JSON.stringify(kindFixtures(), null, 2) + "\n");
