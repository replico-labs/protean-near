import { readLinks, updateLinks } from "./chatStore.js";

/**
 * Which DAO each chat runs. One entry per "<platform>:<chatId>":
 *   daoId      the core (a Sputnik DAO)
 *   orbitId    the orbit governing it
 *   orbitType  "tokenWeight"
 *   tokenId    the voting token
 *   stakingId  the staking contract reporting to the orbit
 *   linkedBy   platform user ID of whoever linked it
 */

const key = (platform, chatId) => `${platform}:${chatId}`;

export function getChatDao(platform, chatId) {
  return readLinks()[key(platform, chatId)] ?? null;
}

export function setChatDao(platform, chatId, link) {
  updateLinks((links) => {
    links[key(platform, chatId)] = link;
  });
}

export function removeChatDao(platform, chatId) {
  updateLinks((links) => {
    if (!(key(platform, chatId) in links)) return false;
    delete links[key(platform, chatId)];
  });
}

/** Every linked chat on `platform`, as [chatId, link]. */
export function chatsOn(platform) {
  const prefix = `${platform}:`;
  return Object.entries(readLinks())
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, link]) => [k.slice(prefix.length), link]);
}
