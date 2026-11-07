import { view, call } from "./client.js";

/**
 * A guard (orbits/orbit-guard): signers between the governing orbit and the
 * core. Passed proposals arrive as instructions; once enough signers
 * confirm one, the guard runs it on the core.
 */

export const getConfig = (guardId) => view(guardId, "get_config");
export const getInstructionCount = (guardId) => view(guardId, "get_instruction_count");
export const getInstruction = (guardId, id) => view(guardId, "get_instruction", { id: Number(id) });
export const getInstructions = (guardId, fromIndex, limit) => view(guardId, "get_instructions", { from_index: fromIndex, limit });
export const getVote = (guardId, id, signer) => view(guardId, "get_vote", { id: Number(id), signer });

/** Confirms instruction `id`; the confirmation that reaches the threshold runs it on the core. */
export const confirm = (account, guardId, id) => call(account, guardId, "confirm", { id: Number(id) });
export const reject = (account, guardId, id) => call(account, guardId, "reject", { id: Number(id) });
export const revoke = (account, guardId, id) => call(account, guardId, "revoke", { id: Number(id) });
/** Runs a confirmed instruction on the core again, if that failed. */
export const send = (account, guardId, id) => call(account, guardId, "send", { id: Number(id) });
