import { encodeFunctionData, keccak256, serializeTransaction, parseTransaction, recoverTransactionAddress, maxUint256 } from "viem";
import { NETWORK_ID } from "../config.js";

/**
 * EVM chains the DAO acts on through Chain Signatures, and the
 * transactions it proposes there. Addresses for Aave are from Aave's
 * address book (github.com/bgd-labs/aave-address-book).
 *
 * A proposal carries its unsigned transactions in its description, after a
 * marker, so anyone can check what the DAO is signing and the bot can
 * assemble and send them once the signatures exist.
 */

const CHAINS = {
  base: {
    mainnet: {
      chainId: 8453,
      rpc: "https://mainnet.base.org",
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
      aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
      // Aave's gateway wraps ETH to WETH and supplies it, and the reverse.
      wethGateway: "0xa0d9C1E9E48Ca30c8d8C3B5D69FF5dc1f6DFfC24",
      aWeth: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7",
    },
    testnet: {
      chainId: 84532,
      rpc: "https://sepolia.base.org",
      usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      aavePool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      aUsdc: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
      wethGateway: "0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6",
      aWeth: "0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb",
    },
  },
};

/** Base on this network: Base itself with mainnet, Base Sepolia otherwise. BASE_RPC_URL overrides the RPC. */
export function base() {
  const config = CHAINS.base[NETWORK_ID === "mainnet" ? "mainnet" : "testnet"];
  return { name: NETWORK_ID === "mainnet" ? "Base" : "Base Sepolia", ...config, rpc: process.env.BASE_RPC_URL || config.rpc };
}

async function rpc(chain, method, params = []) {
  const res = await fetch(chain.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${chain.name}: ${body.error.message}`);
  return body.result;
}

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
];
const AAVE_POOL = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

const WETH_GATEWAY = [
  { type: "function", name: "depositETH", stateMutability: "payable", inputs: [{ name: "pool", type: "address" }, { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" }], outputs: [] },
  { type: "function", name: "withdrawETH", stateMutability: "nonpayable", inputs: [{ name: "pool", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }], outputs: [] },
];

/** ETH (wei) and a token's balance (raw units) of `address` on `chain`. */
export async function balances(chain, address, tokens) {
  const eth = BigInt(await rpc(chain, "eth_getBalance", [address, "latest"]));
  const held = {};
  for (const [name, token] of Object.entries(tokens)) {
    const data = encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [address] });
    held[name] = BigInt(await rpc(chain, "eth_call", [{ to: token, data }, "latest"]));
  }
  return { eth, ...held };
}

/** Aave: approve the pool for `amount` USDC, then supply it on behalf of `owner`. */
export function aaveSupplyCalls(chain, owner, amount) {
  return [
    { to: chain.usdc, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [chain.aavePool, amount] }), gas: 80_000n },
    { to: chain.aavePool, data: encodeFunctionData({ abi: AAVE_POOL, functionName: "supply", args: [chain.usdc, amount, owner, 0] }), gas: 350_000n },
  ];
}

/** Aave: withdraw `amount` USDC (null: everything) to `owner`. */
export function aaveWithdrawCalls(chain, owner, amount) {
  return [{ to: chain.aavePool, data: encodeFunctionData({ abi: AAVE_POOL, functionName: "withdraw", args: [chain.usdc, amount ?? maxUint256, owner] }), gas: 350_000n }];
}

/** Aave: supply `amount` ETH (wei) on behalf of `owner`, through the gateway, which wraps it. */
export function aaveSupplyEthCalls(chain, owner, amount) {
  return [{ to: chain.wethGateway, data: encodeFunctionData({ abi: WETH_GATEWAY, functionName: "depositETH", args: [chain.aavePool, owner, 0] }), value: amount, gas: 300_000n }];
}

/**
 * Aave: withdraw `amount` ETH (null: everything) to `owner`. The gateway
 * takes the aWETH back, so it's approved for it first.
 */
export function aaveWithdrawEthCalls(chain, owner, amount) {
  return [
    { to: chain.aWeth, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [chain.wethGateway, amount ?? maxUint256] }), gas: 80_000n },
    { to: chain.wethGateway, data: encodeFunctionData({ abi: WETH_GATEWAY, functionName: "withdrawETH", args: [chain.aavePool, amount ?? maxUint256, owner] }), gas: 400_000n },
  ];
}

/**
 * The chain's next nonce for `from` and fees generous enough to still be
 * accepted after a vote: five times the current base fee plus the tip.
 */
export async function txParams(chain, from) {
  const [nonce, block, tip] = await Promise.all([
    rpc(chain, "eth_getTransactionCount", [from, "pending"]),
    rpc(chain, "eth_getBlockByNumber", ["latest", false]),
    rpc(chain, "eth_maxPriorityFeePerGas").catch(() => "0x0"),
  ]);
  const priority = BigInt(tip);
  const maxFee = BigInt(block.baseFeePerGas) * 5n + priority;
  const floor = 100_000_000n; // 0.1 gwei
  return { nonce: Number(BigInt(nonce)), maxFeePerGas: maxFee > floor ? maxFee : floor, maxPriorityFeePerGas: priority };
}

/** Unsigned EIP-1559 transactions for `calls`, numbered from `params.nonce`, with each hash to sign. */
export function unsignedTxs(chain, calls, params) {
  return calls.map((call, i) => {
    const tx = {
      type: "eip1559",
      chainId: chain.chainId,
      nonce: params.nonce + i,
      to: call.to,
      data: call.data,
      value: call.value ?? 0n,
      gas: call.gas,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    };
    const serialized = serializeTransaction(tx);
    return { serialized, hash: keccak256(serialized), maxCost: call.gas * params.maxFeePerGas + (call.value ?? 0n) };
  });
}

/** An unsigned transaction's fields. */
export const parseTx = (serialized) => parseTransaction(serialized);

/** `serialized` (unsigned) with `signature` applied, after checking it was signed by `from`. */
export async function signedTx(serialized, signature, from) {
  const tx = parseTransaction(serialized);
  const signed = serializeTransaction(tx, signature);
  const signer = await recoverTransactionAddress({ serializedTransaction: signed });
  if (signer.toLowerCase() !== from.toLowerCase()) throw new Error(`Signed by ${signer}, not the DAO's ${from}`);
  return signed;
}

/** Sends a signed transaction; returns its hash. */
export const broadcast = (chain, signed) => rpc(chain, "eth_sendRawTransaction", [signed]);

// --- The unsigned transactions a proposal carries, after its human description ---

const MARKER = "\n\n---\nevm:";

/** `description` with `{chain, from, txs}` appended for the bot and anyone checking. */
export const withTxs = (description, payload) => `${description}${MARKER}${JSON.stringify(payload)}`;

/** The transactions a proposal's description carries, or null. */
export function txsIn(description) {
  const at = String(description ?? "").indexOf(MARKER);
  if (at < 0) return null;
  try {
    return JSON.parse(description.slice(at + MARKER.length));
  } catch {
    return null;
  }
}

/** What people should read: the description without the transactions. */
export const readable = (description) => String(description ?? "").split(MARKER)[0];
