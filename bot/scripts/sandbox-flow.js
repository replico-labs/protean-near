// Runs Protean end to end on a local NEAR node, through the bot's own
// commands: the same code a Telegram or Discord message runs, with only the
// chat and the key store replaced by in-memory ones. Every contract call,
// account and DAO is real.
//
//   node --env-file=.env.sandbox scripts/sandbox-flow.js
//
// Needs a running near-sandbox prepared by scripts/sandbox-setup.js, and the
// contracts published there (scripts/publish-contracts.js --yes).
// Voting periods are a minute; the script moves the sandbox's clock forward
// instead of waiting.
import assert from "node:assert/strict";
import { services, RUN, account, link, chatId, run, rpc, advance, step, near, propose, pass } from "./sandbox-lib.js";

const { nearToYocto, yoctoToNear } = await import("near-api-js");
const { OPERATOR_ACCOUNT_ID } = await import("../src/config.js");
const { operatorAccount, signingAccount, accountExists, availableBalance, view, call } = await import("../src/near/client.js");
const deploy = await import("../src/near/deploy.js");
const { modelConfig, MODULE_CONTRACT } = await import("../src/near/models.js");

const E18 = 10n ** 18n;
const name = `ark${RUN}`;

// ---------------------------------------------------------------------------

step(`Alice creates a token-weighted DAO "${name}" from the chat`);
await run(1, `createdao ${name} ARK 1000000`, { expect: /is live/ });
const { daoId, tokenId } = link();
const [alice, bob, carol] = [account(1), account(2), account(3)];
assert.deepEqual((await view(daoId, "get_policy")).roles.find((r) => r.name === "governance").kind.Group, [link().orbitId]);
console.log(`  The core ${daoId} has one member: the orbit ${link().orbitId}`);

step("Members get tokens and stake them");
await run(2, "wallet", { expect: /Your account/ });
await run(3, "wallet", { expect: /Your account/ });
await run(1, `send 300000 ARK ${bob}`);
await run(1, `send 100000 ARK ${carol}`);
await run(1, "stake 500000");
await run(2, "stake 300000");
await run(3, "stake 100000");

step("Someone funds the treasury with 5 NEAR");
await operatorAccount().transfer({ receiverId: daoId, amount: nearToYocto("5") });
await advance(0.1);

step("A payout: propose, vote, execute");
const carolBefore = await availableBalance(carol);
await run(1, `pay 1 NEAR ${carol} first payout`, { expect: /#0\b/ });
await run(1, "vote 0 for");
await run(2, "vote 0 against");
await run(3, "vote 0 for");
await run(1, "execute 0", { expect: /hasn't|not|timelock|still/i });
await advance(2.5);
await run(2, "execute 0", { expect: /executed/i });
const carolGain = (await availableBalance(carol)) - carolBefore;
assert.ok(carolGain >= nearToYocto("0.99"), `carol got ${near(carolGain)}`);
console.log(`  ✔ carol received ${near(carolGain)} from the treasury (600k for, 300k against)`);

step("The same proposal can't execute twice");
await run(1, "execute 0", { expect: /already executed/ });

step("A model switch: token-weighted → quadratic, same treasury and stakes");
const treasuryBefore = await availableBalance(daoId);
await run(1, "switchmodel quadratic", { expect: /#1\b/ });
await run(1, "vote 1 for");
await run(2, "vote 1 for");
await advance(2.5);
await run(3, "execute 1", { expect: /now runs quadratic|executed/i });
const governing = (await view(daoId, "get_policy")).roles.find((r) => r.name === "governance").kind.Group;
assert.equal(link().model, "quadratic");
assert.deepEqual(governing, [link().orbitId]);
assert.equal((await view(link().orbitId, "get_model")).Quadratic !== undefined, true);
console.log(`  ✔ the core's only member is now ${link().orbitId} (the quadratic module); treasury ${near(treasuryBefore)} → ${near(await availableBalance(daoId))}`);

step("Quadratic: weights are square roots of the same stakes");
await advance(0.1);
await run(3, `pay 0.5 NEAR ${carol} quadratic payout`, { expect: /#0\b/ });
await run(1, "vote 0 against");
await run(2, "vote 0 for");
await run(3, "vote 0 for");
const p = await view(link().orbitId, "get_proposal", { id: 0 });
const isqrt = (x) => {
  let r = BigInt(Math.floor(Math.sqrt(Number(x))));
  while (r * r > x) r--;
  while ((r + 1n) * (r + 1n) <= x) r++;
  return r;
};
assert.equal(BigInt(p.against_votes), isqrt(500000n * E18));
assert.equal(BigInt(p.for_votes), isqrt(300000n * E18) + isqrt(100000n * E18));
console.log(`  ✔ against ${p.against_votes} (√ of alice's 500k) vs for ${p.for_votes} (√300k + √100k): bob and carol outvote alice`);
await advance(2.5);
await run(1, "execute 0", { expect: /executed/i });

if (process.env.RHEA_EXCHANGE_ID) {
  // Venues from scripts/sandbox-venues.js: Rhea's exchange with a NEAR/USDC pool, and LiNEAR.
  const usdc = JSON.parse(process.env.KNOWN_TOKENS).USDC;
  const usdcOf = async (accountId) => BigInt(await view(usdc, "ft_balance_of", { account_id: accountId }));
  const linear = process.env.LINEAR_ID;

  step("Treasury: swap 1 NEAR for USDC on Rhea, by proposal");
  await operatorAccount().transfer({ receiverId: daoId, amount: nearToYocto("5") });
  const nearBefore = await availableBalance(daoId);
  const usdcStart = await usdcOf(daoId);
  const quoted = BigInt(await view(process.env.RHEA_EXCHANGE_ID, "get_return", { pool_id: 0, token_in: process.env.WRAP_NEAR_ID, amount_in: String(nearToYocto("1")), token_out: usdc }));
  await pass(await propose("swap 1 NEAR USDC"));
  const usdcAfter = await usdcOf(daoId);
  assert.ok(usdcAfter - usdcStart >= (quoted * 99n) / 100n, `the treasury got ${usdcAfter - usdcStart} USDC units for a quote of ${quoted}`);
  assert.ok(nearBefore - (await availableBalance(daoId)) >= nearToYocto("1"), "1 NEAR left the treasury");
  console.log(`  ✔ the treasury sold 1 NEAR for ${Number(usdcAfter - usdcStart) / 1e6} USDC (quoted ${Number(quoted) / 1e6})`);

  step("Treasury: swap USDC back to NEAR, with a tight 0.5% slippage");
  await pass(await propose("swap 2 USDC NEAR 0.5%"));
  assert.equal(await usdcOf(daoId), usdcAfter - 2_000_000n);
  console.log(`  ✔ 2 USDC sold; the treasury holds ${Number(await usdcOf(daoId)) / 1e6} USDC`);

  step("Treasury: a swap whose minimum can't be met reverts and keeps the funds");
  const id = await propose("swap 1 NEAR USDC 0.01%");
  // Someone else buys USDC first, moving the price past the 0.01% the proposal allows.
  const trader = signingAccount(OPERATOR_ACCOUNT_ID, process.env.NEAR_OPERATOR_PRIVATE_KEY);
  await call(trader, process.env.WRAP_NEAR_ID, "storage_deposit", { account_id: OPERATOR_ACCOUNT_ID, registration_only: true }, { deposit: nearToYocto("0.00125") });
  await call(trader, process.env.WRAP_NEAR_ID, "near_deposit", {}, { deposit: nearToYocto("20") });
  await call(trader, usdc, "storage_deposit", { account_id: OPERATOR_ACCOUNT_ID, registration_only: true }, { deposit: nearToYocto("0.00125") });
  const route = [{ pool_id: 0, token_in: process.env.WRAP_NEAR_ID, token_out: usdc, amount_in: String(nearToYocto("20")), min_amount_out: "0" }];
  await call(trader, process.env.WRAP_NEAR_ID, "ft_transfer_call", { receiver_id: process.env.RHEA_EXCHANGE_ID, amount: String(nearToYocto("20")), msg: JSON.stringify({ actions: route }) }, { deposit: 1n });
  const [usdcBefore, wnearBefore] = [await usdcOf(daoId), BigInt(await view(process.env.WRAP_NEAR_ID, "ft_balance_of", { account_id: daoId }))];
  for (const u of [1, 2, 3]) await run(u, `vote ${id} for`);
  await advance(2.5);
  await run(3, `execute ${id}`);
  const core = (await view(daoId, "get_proposal", { id: (await view(link().orbitId, "get_proposal", { id })).core_proposal_id })).status;
  assert.equal(await usdcOf(daoId), usdcBefore, "no USDC arrived");
  const wnearAfter = BigInt(await view(process.env.WRAP_NEAR_ID, "ft_balance_of", { account_id: daoId }));
  console.log(`  ✔ the swap reverted (core proposal ${core}); the treasury keeps its NEAR (as wNEAR: ${near(wnearAfter - wnearBefore)}) and its USDC`);

  step("Treasury: liquid staking with LiNEAR");
  await pass(await propose("liquidstake 2"));
  const staked = BigInt(await view(linear, "get_account_staked_balance", { account_id: daoId }));
  const shares = BigInt(await view(linear, "ft_balance_of", { account_id: daoId }));
  assert.ok(staked >= nearToYocto("1.99"), `staked ${near(staked)}`);
  console.log(`  ✔ the treasury staked ${near(staked)} and holds ${yoctoToNear(shares)} LiNEAR`);
  await pass(await propose("liquidunstake 1"));
  const position = { unstaked: BigInt(await view(linear, "get_account_unstaked_balance", { account_id: daoId })) };
  assert.ok(position.unstaked >= nearToYocto("0.99"), `unstaking ${near(position.unstaked)}`);
  await run(1, "liquidwithdraw", { expect: /still unstaking/ });
  console.log(`  ✔ ${near(position.unstaked)} is unstaking; withdrawing is refused until it's ready`);
  await run(2, "treasury", { expect: /USDC[\s\S]*Staked with LiNEAR[\s\S]*Unstaking from LiNEAR/ });
}

if (process.env.INTENTS_ID) {
  // The NEAR Intents Verifier is real (scripts/sandbox-venues.js). Its 1Click
  // API, which quotes and runs the solvers, isn't reachable from a sandbox, so
  // its token list, quotes and status are stood in for here.
  const intentsId = process.env.INTENTS_ID;
  const wrapId = process.env.WRAP_NEAR_ID;
  const realIntents = await import("../src/near/intents.js");
  const depositAddress = (await import("node:crypto")).randomBytes(32).toString("hex");
  const listed = [
    { assetId: `nep141:${wrapId}`, symbol: "wNEAR", blockchain: "near", decimals: 24 },
    { assetId: "nep141:btc.omft.near", symbol: "BTC", blockchain: "btc", decimals: 8 },
  ];
  services.intents = {
    ...realIntents,
    tokens: async () => listed,
    nearAsset: async (id) => listed.find((t) => t.assetId === `nep141:${id === "NEAR" ? wrapId : id}`) ?? null,
    findAsset: async (text) => listed.find((t) => t.symbol.toLowerCase() === String(text).toLowerCase()) ?? null,
    quote: async (r) => ({ depositAddress, correlationId: "sandbox", amountIn: String(r.amount), amountOut: "150000", minAmountOut: "148500", deadline: new Date(r.deadline.getTime() + 60_000).toISOString() }),
    status: async () => ({ status: "PENDING_DEPOSIT" }),
  };

  step("NEAR Intents: buy BTC with 1 NEAR; the proposal deposits into the quote's NEAR Intents account");
  await operatorAccount().transfer({ receiverId: daoId, amount: nearToYocto("2") });
  const id = await propose("buy 1 NEAR BTC");
  await run(2, `intentsstatus ${id}`, { expect: /waiting for the deposit/ });
  await pass(id);
  const credited = BigInt(await view(intentsId, "mt_balance_of", { account_id: depositAddress, token_id: `nep141:${wrapId}` }));
  assert.equal(credited, nearToYocto("1"));
  console.log(`  ✔ the Verifier credited ${near(credited)} (as wNEAR) to the quote's account ${depositAddress.slice(0, 10)}…, where solvers fill it`);

  step("NEAR Intents: a refund held in the DAO's Intents account comes back to the treasury by proposal");
  // Stands in for a refund: 3 wNEAR credited to the DAO's own NEAR Intents account.
  const operator = operatorAccount();
  await call(operator, wrapId, "storage_deposit", { account_id: OPERATOR_ACCOUNT_ID, registration_only: true }, { deposit: nearToYocto("0.00125") });
  await call(operator, wrapId, "near_deposit", {}, { deposit: nearToYocto("3") });
  await call(operator, wrapId, "ft_transfer_call", { receiver_id: intentsId, amount: String(nearToYocto("3")), msg: daoId }, { deposit: 1n });
  await run(1, "treasury", { expect: /In NEAR Intents: 3 wNEAR/ });
  const wnear = async () => BigInt(await view(wrapId, "ft_balance_of", { account_id: daoId }));
  const before = await wnear();
  await pass(await propose("intentswithdraw 3 NEAR"));
  assert.equal((await wnear()) - before, nearToYocto("3"));
  assert.equal(BigInt(await view(intentsId, "mt_balance_of", { account_id: daoId, token_id: `nep141:${wrapId}` })), 0n);
  console.log("  ✔ the DAO withdrew its 3 wNEAR from NEAR Intents to the treasury, through its own proposal (auth by caller)");
}

if (process.env.CHAIN_SIGNER_ID) {
  // The signer is a stand-in with the real interface and key derivation
  // (scripts/sandbox-venues.js). Base itself isn't reachable from a sandbox,
  // so its nonce, fees, balances and the final send are stood in for; the
  // signatures and the transactions they sign are real.
  const realEvm = await import("../src/near/evm.js");
  const { parseTransaction, recoverTransactionAddress, decodeFunctionData } = await import("viem");
  const sent = [];
  let baseDown = false;
  services.evm = {
    ...realEvm,
    txParams: async () => ({ nonce: 0, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    balances: async () => ({ eth: 10n ** 16n, usdc: 20_000_000n, aUsdc: 0n, aWeth: 0n }),
    broadcast: async (chain, signed) => {
      if (baseDown) {
        baseDown = false;
        throw new Error("Base is down");
      }
      sent.push(signed);
      return `0x${"0".repeat(63)}${sent.length}`;
    },
  };

  step("Chain Signatures: the DAO has its own EVM address, derived by the signer from its account");
  const address = await services.chainsig.evmAddress(daoId);
  await run(2, "evm", { expect: new RegExp(address) });

  step("Aave on Base: supply 5 USDC by proposal; executing signs and sends approve + supply");
  await pass(await propose("aave supply 5"));
  assert.equal(sent.length, 2, "approve, then supply");
  const chain = realEvm.base();
  const [approve, supply] = sent.map((raw) => parseTransaction(raw));
  for (const raw of sent) assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), address.toLowerCase());
  assert.equal(approve.to.toLowerCase(), chain.usdc.toLowerCase());
  assert.equal(supply.to.toLowerCase(), chain.aavePool.toLowerCase());
  assert.deepEqual([approve.nonce, supply.nonce, supply.chainId], [0, 1, chain.chainId]);
  const AAVE = [{ type: "function", name: "supply", inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" }], outputs: [] }];
  const { args } = decodeFunctionData({ abi: AAVE, data: supply.data });
  assert.deepEqual([args[0].toLowerCase(), args[1], args[2].toLowerCase()], [chain.usdc.toLowerCase(), 5_000_000n, address.toLowerCase()]);
  console.log(`  ✔ two transactions signed by the DAO's address ${address} through its proposal: approve, then supply 5 USDC to Aave on its behalf`);

  step("Aave: supply 0.002 ETH through Aave's gateway, while the RPC gives up waiting for the signatures and Base fails once");
  // The RPC stops waiting once the transaction is sent, as a slow signing network can make it do:
  // the bot then reads the execution's outcome by its hash.
  const ethId = await propose("aave supply 0.002 ETH");
  for (const u of [1, 2, 3]) await run(u, `vote ${ethId} for`);
  await advance(2.5);
  const { provider } = await import("../src/near/client.js");
  const realSend = provider.sendTransactionUntil.bind(provider);
  let timedOut = 0;
  provider.sendTransactionUntil = async (signed, waitUntil) => {
    // Only the execution (a call to the orbit) times out; the bot's other transactions go through.
    if (signed.transaction.receiverId !== link().orbitId) return realSend(signed, waitUntil);
    provider.sendTransactionUntil = realSend;
    realSend(signed, "INCLUDED").catch(() => {});
    timedOut++;
    throw new Error("Request timed out");
  };
  baseDown = true;
  sent.length = 0;
  await run(3, `execute ${ethId}`, { expect: /Transaction 1 wasn't sent: Base is down[\s\S]*`\/execute \d+` tries sending again/ });
  assert.equal(timedOut, 1, "the execution's RPC wait gave up");
  await run(3, `execute ${ethId}`, { expect: /executed earlier; sending what it signed[\s\S]*Sent on Base Sepolia/ });
  const [deposit] = sent.map((raw) => parseTransaction(raw));
  assert.equal((await recoverTransactionAddress({ serializedTransaction: sent[0] })).toLowerCase(), address.toLowerCase());
  assert.equal(deposit.to.toLowerCase(), chain.wethGateway.toLowerCase());
  assert.equal(deposit.value, 2n * 10n ** 15n);
  await run(3, `execute ${ethId}`, { expect: /already executed/ });
  console.log("  ✔ the outcome was read by hash after the RPC gave up; the second /execute sent the signed depositETH (0.002 ETH to Aave's gateway)");

  step("Hyperliquid: appoint a trading agent by proposal; the DAO's key signs Hyperliquid's approveAgent");
  // Hyperliquid's API isn't reachable from a sandbox: the post is stood in for, after the same signature check.
  const realHl = await import("../src/near/hyperliquid.js");
  const { recoverAddress } = await import("viem");
  const accepted = [];
  services.hyperliquid = {
    ...realHl,
    account: async () => ({ accountValue: "0", withdrawable: "0", positions: [] }),
    submit: async (action, signature, from) => {
      const signer = await recoverAddress({ hash: realHl.digest(action), signature });
      if (signer.toLowerCase() !== from.toLowerCase()) throw new Error(`signed by ${signer}`);
      accepted.push({ action, signer });
      return { status: "ok" };
    },
  };
  const agent = "0x1111111111111111111111111111111111111111";
  await pass(await propose(`hlagent ${agent} desk`));
  assert.equal(accepted.length, 1);
  assert.deepEqual([accepted[0].action.type, accepted[0].action.agentAddress, accepted[0].action.agentName], ["approveAgent", agent, "desk"]);
  assert.equal(accepted[0].signer.toLowerCase(), address.toLowerCase());
  console.log(`  ✔ the DAO's address signed approveAgent for ${agent} ("desk"): it can trade for the DAO, never withdraw`);
}

step("Notifications: the bot posts in the chat when voting ends and the proposal can execute");
{
  const { scanChat } = await import("../src/platforms/notifier.js");
  const posted = [];
  // The sandbox's clock runs ahead of this machine's (it's fast-forwarded): read the time from the chain.
  const chainNow = async () => BigInt((await rpc("block", { finality: "final" })).header.timestamp);
  const notify = async () => scanChat("telegram", chatId(), link(), (c, text) => posted.push(text), (n) => `/${n}`, await chainNow());
  const id = await propose(`pay 0.1 NEAR ${account(3)} notified payout`);
  await notify();
  for (const u of [1, 2, 3]) await run(u, `vote ${id} for`);
  await notify();
  assert.equal(posted.length, 0, "nothing while voting is open");
  await advance(2.5);
  await notify();
  assert.equal(posted.length, 1);
  assert.match(posted[0], new RegExp(`Voting ended: \\*#${id}\\* — notified payout passed and can be executed now with \`/execute ${id}\``));
  await notify();
  assert.equal(posted.length, 1, "posted once");
  await run(3, `execute ${id}`, { expect: /executed/i });
  console.log(`  ✔ the bot posted: ${posted[0]}`);
}

step("Switch to conviction, which locks stake while it backs a proposal");
const convictionSwitch = Number(/\*#(\d+)\*/.exec((await run(2, "switchmodel conviction", { expect: /New proposal|#\d/ })).text)[1]);
for (const u of [1, 2, 3]) await run(u, `vote ${convictionSwitch} for`);
await advance(2.5);
await run(1, `execute ${convictionSwitch}`, { expect: /now runs conviction|executed/i });
assert.equal(await view(link().stakingId, "get_locker"), link().orbitId);
console.log(`  ✔ the conviction orbit is the staking contract's locker`);
await run(3, `pay 1 NEAR ${carol} conviction payout`, { expect: /#0\b/ });
await run(1, "support 0");
await run(2, "support 0");
await run(1, "unstake 1", { expect: /locked|backing|can't|cannot/i });
await advance(30);
await run(3, "queue 0", { expect: /queued/i });
await advance(2);
await run(3, "execute 0", { expect: /executed/i });
await run(1, "withdrawsupport");

step("Every module is live on chain, and each runs only its own model");
const contracts = deploy.publishedContracts("tokenWeighted");
const base = `${name}.${OPERATOR_ACCOUNT_ID}`;
const namespace = signingAccount(base, process.env.NEAR_OPERATOR_PRIVATE_KEY);
for (const [model, contract] of Object.entries(MODULE_CONTRACT)) {
  const orbitId = await deploy.createOrbit({ name, daoId, tokenId, stakingId: link().stakingId, model, supply: 1_000_000n * E18, council: [alice, bob, carol] });
  const settings = await view(orbitId, "get_model");
  assert.ok(Object.keys(settings)[0].toLowerCase() === model.toLowerCase(), `${orbitId}: ${JSON.stringify(settings).slice(0, 80)}`);
  console.log(`  ✔ ${contract.padEnd(24)} ${orbitId}`);
}
await operatorAccount().transfer({ receiverId: base, amount: nearToYocto("0.5") });
const wrong = `wrong.${base}`;
await assert.rejects(
  namespace.signAndSendTransaction({
    receiverId: wrong,
    actions: [
      (await import("near-api-js")).actions.createAccount(),
      (await import("near-api-js")).actions.transfer(nearToYocto("0.2")),
      (await import("near-api-js")).actions.useGlobalContract({ codeHash: contracts.orbit_token_weighted.codeHashHex }),
      (await import("near-api-js")).actions.functionCall("new", { dao_id: daoId, staking_id: link().stakingId, token_id: tokenId, model: modelConfig("quadratic", 10n ** 24n), council: null }, 100_000_000_000_000n, 0n),
    ],
  }),
  /ERR_MODEL/,
);
assert.equal(await accountExists(wrong), false);
console.log("  ✔ the token-weighted module refuses quadratic settings, and nothing is created");

step("A board DAO: Sputnik's own multisig, no orbit");
await run(1, "unlink", { expect: /unlinked|no longer/i });
await run(1, `createdao ${name}b BRD 1000 board ${alice} ${bob} ${carol}`, { expect: /is live/ });
await operatorAccount().transfer({ receiverId: link().daoId, amount: nearToYocto("2") });
await run(1, `pay 1 NEAR ${carol} board payout`, { expect: /#0\b/ });
await run(1, "vote 0 for");
await run(2, "vote 0 for", { expect: /executed|approved|passed/i });
const proposal = await view(link().daoId, "get_proposal", { id: 0 });
assert.equal(proposal.status, "Approved");
console.log("  ✔ two of three board members approved and Sputnik paid out");

console.log("\nAll checks passed.");
