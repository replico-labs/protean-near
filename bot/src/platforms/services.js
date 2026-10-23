import * as orbit from "../near/orbit.js";
import * as staking from "../near/staking.js";
import * as core from "../near/core.js";
import * as deploy from "../near/deploy.js";
import * as rhea from "../near/rhea.js";
import * as lst from "../near/lst.js";
import * as tokens from "../near/tokens.js";
import * as intents from "../near/intents.js";
import * as chainsig from "../near/chainsig.js";
import * as evm from "../near/evm.js";
import * as hyperliquid from "../near/hyperliquid.js";
import { VENUES } from "../near/venues.js";
import { getOrCreateUserAccount, ensureGas, findUserAccountId, gasHoldNear } from "../near/wallets.js";
import { availableBalance } from "../near/client.js";
import { getChatDao, setChatDao, removeChatDao, chatsOn } from "../db.js";
import { isWalletStoreConfigured, getOrCreateAgentKey, findAgentAddress } from "../walletStore.js";

/**
 * Everything the commands touch outside themselves: the chain, wallets and
 * chat links. Tests swap these for fakes.
 */
export const services = {
  orbit,
  staking,
  core,
  deploy,
  rhea,
  lst,
  tokens,
  intents,
  chainsig,
  evm,
  hyperliquid,
  venues: VENUES,
  wallets: { getOrCreateUserAccount, ensureGas, findUserAccountId, availableBalance, gasHoldNear },
  db: { getChatDao, setChatDao, removeChatDao, chatsOn },
  hlAgents: { getOrCreateAgentKey, findAgentAddress },
  isWalletStoreConfigured,
};
