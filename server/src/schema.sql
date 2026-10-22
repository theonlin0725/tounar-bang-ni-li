PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  email_display TEXT NOT NULL,
  allowlisted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  deletion_blocked INTEGER NOT NULL DEFAULT 0,
  deletion_generation INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  request_ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_otp_email_created ON otp_challenges(email_normalized, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  auth_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  company_key TEXT NOT NULL,
  job_title TEXT NOT NULL,
  site_key TEXT,
  site_job_id TEXT,
  site_application_id TEXT,
  recruitment_batch TEXT,
  location TEXT,
  jd_summary TEXT,
  channel TEXT NOT NULL DEFAULT '未知',
  job_url TEXT,
  canonical_job_url TEXT,
  status_url TEXT,
  status_url_scope TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  has_applied INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT,
  applied_at_precision TEXT NOT NULL DEFAULT 'unknown',
  first_viewed_at TEXT,
  last_viewed_at TEXT,
  form_started_at TEXT,
  last_status_changed_at TEXT,
  last_progress_at TEXT,
  last_site_observed_at TEXT,
  last_reviewed_at TEXT,
  deadline_at TEXT,
  deadline_precision TEXT,
  interview_round INTEGER,
  round_label TEXT,
  interview_scheduled_at TEXT,
  last_interview_completed_at TEXT,
  stage_followup_anchor TEXT,
  source_methods_json TEXT NOT NULL DEFAULT '[]',
  latest_event_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  archive_reason TEXT,
  last_b_notified_at TEXT,
  last_a_notified_at TEXT,
  deletion_generation INTEGER NOT NULL DEFAULT 0,
  CHECK (status IN ('pending','applied','assessment','interview','offer','rejected','closed')),
  CHECK (has_applied IN (0,1)),
  CHECK (has_applied = 1 OR status IN ('pending','closed'))
);
CREATE INDEX IF NOT EXISTS idx_apps_owner_updated ON applications(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_apps_owner_status ON applications(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_apps_owner_archived ON applications(owner_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_apps_owner_sitejob ON applications(owner_id, site_key, site_job_id);
CREATE INDEX IF NOT EXISTS idx_apps_owner_canonical ON applications(owner_id, canonical_job_url);
CREATE INDEX IF NOT EXISTS idx_apps_owner_siteapp ON applications(owner_id, site_key, site_application_id);

CREATE TABLE IF NOT EXISTS application_history (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_id TEXT,
  from_status TEXT,
  to_status TEXT,
  changed_fields_json TEXT NOT NULL DEFAULT '{}',
  changed_at TEXT NOT NULL,
  source_method TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_app ON application_history(owner_id, application_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS application_field_sources (
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  source_method TEXT NOT NULL,
  event_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (application_id, field)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_event_id TEXT NOT NULL,
  source_method TEXT NOT NULL,
  event_type TEXT NOT NULL,
  site_key TEXT,
  site_job_id TEXT,
  site_application_id TEXT,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  adapter_version TEXT,
  parser_version TEXT,
  evidence_level TEXT NOT NULL,
  evidence_code TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  payload_hash TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'pending',
  review_reason TEXT,
  clock_skew_flag INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  processing_error TEXT,
  connection_id TEXT,
  mailbox TEXT,
  uidvalidity TEXT,
  uid TEXT,
  UNIQUE (owner_id, source_method, client_event_id),
  CHECK (processing_state IN ('pending','applied','ignored','failed'))
);
CREATE INDEX IF NOT EXISTS idx_events_owner_received ON events(owner_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_owner_app ON events(owner_id, application_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_mail_source ON events(connection_id, mailbox, uidvalidity, uid) WHERE connection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  suggested_changes_json TEXT NOT NULL DEFAULT '{}',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  source_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  source_mail_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (status IN ('open','resolved','dismissed'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_owner_status ON review_items(owner_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS review_resolutions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (review_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS plugin_pairings (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_secret_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  exchanged_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (status IN ('pending','approved','exchanged','expired'))
);
CREATE INDEX IF NOT EXISTS idx_pairings_owner ON plugin_pairings(owner_id);

CREATE TABLE IF NOT EXISTS plugin_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  binding_version INTEGER NOT NULL DEFAULT 1,
  pairing_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  last_event_at TEXT,
  server_revoked_at TEXT,
  device_cleanup_state TEXT NOT NULL DEFAULT 'unknown',
  device_cleanup_ack_at TEXT,
  CHECK (device_cleanup_state IN ('unknown','acknowledged'))
);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON plugin_devices(owner_id);

CREATE TABLE IF NOT EXISTS mail_connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  mode TEXT NOT NULL,
  scan_since TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connecting',
  consent_version TEXT NOT NULL,
  credential_ciphertext TEXT,
  credential_iv TEXT,
  credential_tag TEXT,
  last_sync_attempt_at TEXT,
  last_sync_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  binding_version INTEGER NOT NULL DEFAULT 1,
  sync_lease_until TEXT,
  sync_lease_owner TEXT,
  first_scan_total INTEGER,
  first_scan_processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (mode IN ('headers_only','recruitment_body')),
  CHECK (status IN ('connecting','connected','syncing','degraded','reauth_required','disconnected'))
);
CREATE INDEX IF NOT EXISTS idx_mail_owner ON mail_connections(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_owner_active ON mail_connections(owner_id) WHERE status <> 'disconnected';

CREATE TABLE IF NOT EXISTS mail_cursors (
  connection_id TEXT NOT NULL REFERENCES mail_connections(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  uidvalidity TEXT,
  last_uid TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, mailbox)
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mail_connections(id) ON DELETE CASCADE,
  mailbox TEXT NOT NULL,
  uidvalidity TEXT NOT NULL,
  uid TEXT NOT NULL,
  message_id TEXT,
  subject_excerpt TEXT,
  from_domain TEXT,
  received_at TEXT,
  category TEXT,
  processing_state TEXT NOT NULL DEFAULT 'pending',
  review_item_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, mailbox, uidvalidity, uid)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'all',
  review_frequency TEXT NOT NULL DEFAULT 'daily',
  review_threshold_days INTEGER NOT NULL DEFAULT 14,
  stage_followup_days INTEGER NOT NULL DEFAULT 7,
  last_review_digest_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  CHECK (mode IN ('all','changes_only','review_only','off')),
  CHECK (review_frequency IN ('weekly_monday','daily')),
  CHECK (review_threshold_days BETWEEN 7 AND 30),
  CHECK (stage_followup_days IN (0,7,14))
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_received_at TEXT,
  consumed_batch_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_owner_pending ON notification_outbox(owner_id, consumed_batch_id);

CREATE TABLE IF NOT EXISTS notification_batches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_date TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL,
  subject TEXT,
  item_count_a INTEGER NOT NULL DEFAULT 0,
  item_count_b INTEGER NOT NULL DEFAULT 0,
  item_count_c INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, business_date, channel),
  CHECK (status IN ('pending','sending','sent','failed','delivery_unknown','skipped_empty','cancelled'))
);

CREATE TABLE IF NOT EXISTS notification_batch_items (
  batch_id TEXT NOT NULL REFERENCES notification_batches(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, application_id, kind)
);

CREATE TABLE IF NOT EXISTS reminder_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  action TEXT NOT NULL DEFAULT 'reviewed_no_change',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  confirmation_result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminder_owner_app ON reminder_links(owner_id, application_id);

CREATE TABLE IF NOT EXISTS reminder_confirmations (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES reminder_links(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  application_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_tag TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE (link_id, idempotency_key),
  CHECK (state IN ('ready','consumed','expired'))
);

CREATE TABLE IF NOT EXISTS deletion_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  progress_json TEXT NOT NULL DEFAULT '{}',
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  CHECK (status IN ('requested','blocking_writes','deleting','awaiting_device_ack','completed','failed'))
);

CREATE TABLE IF NOT EXISTS deletion_guards (
  owner_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  blocked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, scope, key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_log(owner_id, created_at DESC);

INSERT OR IGNORE INTO meta (key, value) VALUES ('data_revision', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
