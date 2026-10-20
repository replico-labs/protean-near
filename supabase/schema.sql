-- Run this once in the protean-near Supabase project's SQL editor
-- (Database > SQL Editor). It's a separate project from the EVM/Solana bot's.
--
-- Every table has Row Level Security enabled with no policies: only the bot's
-- backend, using the service_role key, can read or write them.

-- One NEAR account per user per chat platform. The account's private key is
-- envelope-encrypted with AWS KMS, with encryption context
-- {"app": "protean-near"}.
create table if not exists wallets (
  platform text not null,                -- telegram, discord, slack
  platform_user_id text not null,
  account_id text not null unique,       -- e.g. "tg123.orbits.testnet"
  public_key text not null,              -- "ed25519:..."
  encrypted_private_key text not null,
  encrypted_data_key text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  primary key (platform, platform_user_id)
);
alter table wallets enable row level security;

-- Chat links: which network, core, orbit, token and staking contract each
-- chat uses. The shape lives in the jsonb, e.g.
-- {"network":"near-testnet","daoId":"...","orbitId":"...","orbitType":"tokenWeight",
--  "tokenId":"...","stakingId":"..."}
create table if not exists chat_links (
  chat_key text primary key,             -- "<platform>:<chat id>", e.g. "telegram:-1001234"
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table chat_links enable row level security;

-- Proposal pages: details a proposer writes for each orbit proposal.
-- An orbit proposal gets a Sputnik proposal id only once it passes.
create table if not exists proposal_details (
  network text not null,                 -- e.g. "near-testnet"
  orbit_id text not null,
  proposal_id text not null,             -- the orbit's own proposal id
  dao_id text not null,
  sputnik_proposal_id bigint,            -- set once the orbit sends it to the core
  orbit_type text not null,
  chat_platform text,
  title text,
  summary text,
  body text,
  links jsonb not null default '[]',
  content_hash text,
  edit_password_hash text,
  version_count int not null default 1,
  password_failures int not null default 0,
  password_locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (network, orbit_id, proposal_id)
);
alter table proposal_details enable row level security;

create table if not exists proposal_detail_versions (
  network text not null,
  orbit_id text not null,
  proposal_id text not null,
  version int not null,                  -- 1 = the first upload
  title text,
  summary text,
  body text,
  links jsonb not null default '[]',
  content_hash text not null,
  saved_at timestamptz not null default now(),
  primary key (network, orbit_id, proposal_id, version)
);
alter table proposal_detail_versions enable row level security;

-- The listener polls orbits for new proposals and status changes (NEAR has no
-- log subscriptions). The last proposal id it has seen per orbit, so a restart
-- neither repeats nor misses anything.
create table if not exists listener_cursors (
  network text not null,
  orbit_id text not null,
  last_proposal_id bigint not null default -1,
  updated_at timestamptz not null default now(),
  primary key (network, orbit_id)
);
alter table listener_cursors enable row level security;

-- Slack: one row per workspace that installed the bot, envelope-encrypted
-- under the same KMS key and context as the wallets. Only needed for Slack.
create table if not exists slack_installations (
  install_key text primary key,          -- "T:<team id>", or "E:<enterprise id>"
  team_id text,
  enterprise_id text,
  encrypted_installation text not null,
  encrypted_data_key text not null,
  iv text not null,
  auth_tag text not null,
  updated_at timestamptz not null default now()
);
alter table slack_installations enable row level security;
