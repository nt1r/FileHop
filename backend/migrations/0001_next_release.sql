CREATE TABLE instance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    storage_id TEXT NOT NULL
);
CREATE TABLE session (
    digest BLOB PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
CREATE TABLE account (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL
);
