import * as tokenWeight from "../near/tokenWeight.js";
import * as core from "../near/core.js";
import { getOrCreateUserAccount, ensureGas, findUserAccountId } from "../near/wallets.js";
import { availableBalance } from "../near/client.js";
import { getChatDao, setChatDao, removeChatDao } from "../db.js";
import { isWalletStoreConfigured } from "../walletStore.js";

/**
 * Everything the commands touch outside themselves: the chain, wallets and
 * chat links. Tests swap these for fakes.
 */
export const services = {
  tokenWeight,
  core,
  wallets: { getOrCreateUserAccount, ensureGas, findUserAccountId, availableBalance },
  db: { getChatDao, setChatDao, removeChatDao },
  isWalletStoreConfigured,
};
