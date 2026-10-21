import * as orbit from "../near/orbit.js";
import * as staking from "../near/staking.js";
import * as core from "../near/core.js";
import * as deploy from "../near/deploy.js";
import { getOrCreateUserAccount, ensureGas, findUserAccountId } from "../near/wallets.js";
import { availableBalance } from "../near/client.js";
import { getChatDao, setChatDao, removeChatDao, chatsOn } from "../db.js";
import { isWalletStoreConfigured } from "../walletStore.js";

/**
 * Everything the commands touch outside themselves: the chain, wallets and
 * chat links. Tests swap these for fakes.
 */
export const services = {
  orbit,
  staking,
  core,
  deploy,
  wallets: { getOrCreateUserAccount, ensureGas, findUserAccountId, availableBalance },
  db: { getChatDao, setChatDao, removeChatDao, chatsOn },
  isWalletStoreConfigured,
};
