PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS badges (
    badge_id TEXT PRIMARY KEY,
    display_number TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS terminal_configs (
    terminal_id TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    site_id TEXT NOT NULL,
    PRIMARY KEY (terminal_id, config_version)
);
INSERT OR IGNORE INTO terminal_configs VALUES ('k230-001', 1, 'A');
CREATE TABLE IF NOT EXISTS visits (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    badge_id TEXT NOT NULL REFERENCES badges(badge_id),
    terminal_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    time_quality TEXT NOT NULL,
    source TEXT NOT NULL,
    dedup_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_window ON visits(session_id, badge_id, site_id, source, dedup_at);
CREATE TABLE IF NOT EXISTS scan_receipts (
    event_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    visit_id TEXT NOT NULL REFERENCES visits(event_id)
);
CREATE TABLE IF NOT EXISTS commands (
    command_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE REFERENCES visits(event_id),
    badge_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS heartbeats (
    terminal_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (terminal_id, site_id)
);
CREATE TABLE IF NOT EXISTS device_challenges (
    challenge TEXT PRIMARY KEY,
    badge_id TEXT NOT NULL REFERENCES badges(badge_id),
    device_id TEXT NOT NULL,
    command_id TEXT REFERENCES commands(command_id),
    expires_at TEXT NOT NULL,
    accepted_payload TEXT
);
CREATE TABLE IF NOT EXISTS verified_progress (
    badge_id TEXT PRIMARY KEY REFERENCES badges(badge_id),
    device_id TEXT NOT NULL,
    flags INTEGER NOT NULL,
    verified_at TEXT NOT NULL
);
