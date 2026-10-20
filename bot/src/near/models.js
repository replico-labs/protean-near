/**
 * The governance models the bot can create, and their settings. The orbit
 * contract's rules follow Protean's EVM models; these are the defaults the
 * bot picks, scaled to the token supply. Periods default to minutes so a
 * chat can try a full lifecycle quickly; set the env vars to lengthen them.
 */

const MIN = 60_000_000_000n; // one minute, in nanoseconds
const minutes = (name, fallback) => BigInt(process.env[name] ?? fallback) * MIN;

export const MODELS = {
  board: "Board: named members approve directly on the DAO (Sputnik's multisig), no token voting",
  tokenWeighted: "Token-weighted: one staked token, one vote",
  quadratic: "Quadratic: voting weight is the square root of stake",
  liquid: "Liquid: vote directly, or delegate your vote to someone",
  optimistic: "Optimistic: passes unless challenged with a bond, then goes to a vote",
  conviction: "Conviction: back one proposal at a time; support builds conviction over time",
  delegate: "Delegate: stakers elect a council that proposes and votes",
  sortition: "Sortition: a council drawn at random from stakers who opt in",
  sowellian: "Sowellian: approve a proposal with its success criteria, bet on the outcome, resolve it after measuring",
  decisionMarkets: "Decision markets: pass and fail markets trade, and the higher price decides",
};

/** The Orbits module contract (orbits/modules) that runs each model, as published. */
export const MODULE_CONTRACT = {
  tokenWeighted: "orbit_token_weighted",
  quadratic: "orbit_quadratic",
  liquid: "orbit_liquid",
  optimistic: "orbit_optimistic",
  conviction: "orbit_conviction",
  delegate: "orbit_delegate",
  sortition: "orbit_sortition",
  sowellian: "orbit_sowellian",
  decisionMarkets: "orbit_decision_markets",
};

/** Short account prefixes for each model's orbit, e.g. "tw.ark.orbits.testnet". */
export const ORBIT_PREFIX = { tokenWeighted: "tw", quadratic: "qv", liquid: "lq", optimistic: "op", conviction: "cv", delegate: "dg", sortition: "st", sowellian: "sw", decisionMarkets: "dm" };

export const isCouncilModel = (model) => model === "delegate" || model === "sortition";
export const isStakeModel = (model) => model !== "board" && !isCouncilModel(model);

/** How long a Sowellian proposal's outcome is measured after it executes. */
export const measurementPeriod = () => String(minutes("MEASUREMENT_MINUTES", 60));

function voteRules(supply) {
  return {
    quorum_bps: Number(process.env.QUORUM_BPS ?? 2000),
    approval_bps: Number(process.env.APPROVAL_BPS ?? 5000),
    voting_delay: String(minutes("VOTING_DELAY_MINUTES", 0)),
    voting_period: String(minutes("VOTING_PERIOD_MINUTES", 60)),
    timelock: String(minutes("TIMELOCK_MINUTES", 1)),
    execution_period: String(minutes("EXECUTION_WINDOW_MINUTES", 72 * 60)),
    proposal_threshold: String(supply / 10_000n), // 0.01% of supply
  };
}

function councilRules(size) {
  return {
    quorum: Math.ceil(size / 2),
    approval_bps: 5000,
    voting_delay: "0",
    voting_period: String(minutes("VOTING_PERIOD_MINUTES", 60)),
    timelock: String(minutes("TIMELOCK_MINUTES", 1)),
    execution_period: String(minutes("EXECUTION_WINDOW_MINUTES", 72 * 60)),
  };
}

/**
 * The orbit's `model` argument for `name`, scaled to the token's raw
 * `supply`, with `councilSize` seats for council models.
 */
export function modelConfig(name, supply, councilSize = 3) {
  const supplyN = BigInt(supply);
  const term = String(minutes("TERM_MINUTES", 7 * 24 * 60));
  switch (name) {
    case "tokenWeighted":
      return { TokenWeighted: voteRules(supplyN) };
    case "quadratic":
      return { Quadratic: voteRules(supplyN) };
    case "liquid":
      return { Liquid: voteRules(supplyN) };
    case "optimistic":
      return {
        Optimistic: {
          rules: voteRules(supplyN),
          challenge_period: String(minutes("CHALLENGE_MINUTES", 60)),
          challenge_bond: String(supplyN / 1_000n), // 0.1% of supply
        },
      };
    case "conviction":
      // Conviction is in stake units. Full support from 10% of supply reaches
      // a simple proposal's 5% bar in about 8 minutes.
      return {
        Conviction: {
          growth_per_second: String(supplyN / 10_000n),
          min_conviction: String(supplyN / 20n),
          near_multiplier: String(supplyN / 1_000n), // +0.1% of supply per NEAR paid
          token_multiplier: String(10n ** 24n), // +1 token of conviction per token paid
          governance_conviction: String(supplyN / 4n), // 25% for anything else
          timelock: String(minutes("TIMELOCK_MINUTES", 1)),
          execution_period: String(minutes("EXECUTION_WINDOW_MINUTES", 72 * 60)),
          proposal_threshold: String(supplyN / 10_000n),
        },
      };
    case "delegate":
      return {
        Delegate: {
          council: councilRules(councilSize),
          council_size: councilSize,
          term_length: term,
          candidacy_threshold: String(supplyN / 100n), // 1%
          candidacy_period: String(minutes("CANDIDACY_MINUTES", 30)),
          election_period: String(minutes("ELECTION_MINUTES", 60)),
          recall_quorum_bps: 1000,
          recall_approval_bps: 5000,
          recall_period: String(minutes("RECALL_MINUTES", 60)),
        },
      };
    case "sortition":
      return {
        Sortition: {
          council: councilRules(councilSize),
          council_size: councilSize,
          term_length: term,
          eligibility_threshold: String(supplyN / 1_000n), // 0.1%
        },
      };
    case "sowellian":
      return {
        Sowellian: {
          approval: voteRules(supplyN),
          proposal_bond: String(supplyN / 10_000n), // 0.01%
          positions_window: String(minutes("POSITIONS_MINUTES", 60)),
          resolution_bond: String(supplyN / 10_000n),
          challenge_period: String(minutes("CHALLENGE_MINUTES", 60)),
          challenge_bond: String(supplyN / 10_000n),
          adjudication_period: String(minutes("ADJUDICATION_MINUTES", 60)),
          adjudication_quorum_bps: 1000,
          adjudication_threshold_bps: 5000,
          max_oracle_staleness: String(minutes("ORACLE_STALENESS_MINUTES", 60)),
        },
      };
    case "decisionMarkets":
      return {
        DecisionMarkets: {
          trading_period: String(minutes("TRADING_MINUTES", 60)),
          threshold_bps: Number(process.env.MARKET_THRESHOLD_BPS ?? 100),
          timelock: String(minutes("TIMELOCK_MINUTES", 1)),
          execution_period: String(minutes("EXECUTION_WINDOW_MINUTES", 72 * 60)),
        },
      };
    default:
      throw new Error(`Unknown model "${name}"`);
  }
}

/** A board DAO's policy: its members approve by simple majority, on the core itself. */
export function boardPolicy(members) {
  return {
    roles: [{ name: "governance", kind: { Group: members }, permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], vote_policy: {} }],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: "0",
    proposal_period: String(minutes("BOARD_PROPOSAL_MINUTES", 7 * 24 * 60)),
    bounty_bond: "0",
    bounty_forgiveness_period: "86400000000000",
  };
}

/** The policy of a DAO governed by `orbitId`: the orbit is its only member. */
export function orbitPolicy(orbitId) {
  return {
    roles: [{ name: "governance", kind: { Group: [orbitId] }, permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], vote_policy: {} }],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] },
    proposal_bond: "0",
    proposal_period: "604800000000000",
    bounty_bond: "0",
    bounty_forgiveness_period: "86400000000000",
  };
}
