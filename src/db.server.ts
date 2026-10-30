import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { config } from "./config.server.ts";

/**
 * SQLite access. One connection, opened at startup, stashed on globalThis so
 * Vite's SSR module re-evaluation doesn't leak handles during development.
 *
 * Time representation, applied consistently throughout the schema:
 *   - An *instant* is INTEGER epoch milliseconds (UTC), in columns named `*_at`.
 *   - A *wall-clock date* is TEXT 'YYYY-MM-DD' in the configured zone, in
 *     columns named `*_date`. A due date is one of these because "when is this
 *     due" is a human question about a calendar day, not a moment.
 * Mixing the two is the classic source of off-by-a-day bugs, so the column type
 * tells you which kind you are holding.
 */

type GlobalWithDb = typeof globalThis & { __punchlistDb__?: Database };

export function db(): Database {
  const conn = (globalThis as GlobalWithDb).__punchlistDb__;
  if (!conn) throw new Error("DB not initialized: call initDb() during startup");
  return conn;
}

/**
 * Open (and migrate) the database. `path` defaults to the configured file;
 * tests pass ":memory:" for an isolated, throwaway database. `log` receives the
 * open/migration lines; the CLI sends them to stderr so its stdout stays
 * machine-readable.
 */
export function initDb(path: string = config.databasePath, log: (line: string) => void = console.log): Database {
  const g = globalThis as GlobalWithDb;
  if (g.__punchlistDb__) return g.__punchlistDb__;

  const inMemory = path === ":memory:";
  // resolve() would turn ":memory:" into a real (and, on Windows, invalid)
  // file path, so leave the in-memory sentinel exactly as SQLite expects it.
  if (!inMemory) {
    path = resolve(path);
    mkdirSync(dirname(path), { recursive: true });
  }

  const conn = new Database(path);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");

  // Throwaway test databases are opened once per test; logging each would bury
  // the output that matters.
  const say = inMemory ? () => {} : log;
  runMigrations(conn, say);

  g.__punchlistDb__ = conn;
  say(`[db] opened ${path}`);
  return conn;
}

/** Close and forget, so a later initDb() opens afresh (integration tests). */
export function closeDb(): void {
  const g = globalThis as GlobalWithDb;
  g.__punchlistDb__?.close();
  g.__punchlistDb__ = undefined;
}

/**
 * A migration is SQL text, not code: the runner records a hash of it, and a
 * hash has to mean the same thing in the bundled server and in a CLI running
 * from source. A string literal survives bundling byte for byte; a function's
 * source does not.
 */
interface Migration {
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    name: "001_initial",
    sql: `
        ---------------------------------------------------------------- people
        CREATE TABLE users (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT NOT NULL,
          role              TEXT NOT NULL CHECK (role IN ('admin','member')),
          -- WebAuthn user handle: 32 random bytes, base64url. Deliberately not
          -- the row id, which would leak account ordering to authenticators.
          webauthn_user_id  TEXT NOT NULL UNIQUE,
          active            INTEGER NOT NULL DEFAULT 1,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX idx_users_active ON users(active);

        CREATE TABLE credentials (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credential_id  TEXT NOT NULL UNIQUE,
          public_key     BLOB NOT NULL,
          counter        INTEGER NOT NULL DEFAULT 0,
          transports     TEXT,
          device_type    TEXT,
          backed_up      INTEGER NOT NULL DEFAULT 0,
          nickname       TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          last_used_at   INTEGER
        );
        CREATE INDEX idx_credentials_user ON credentials(user_id);

        CREATE TABLE sessions (
          id             TEXT PRIMARY KEY, -- SHA-256 of the cookie's token
          user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credential_id  INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
          user_agent     TEXT,
          created_at     INTEGER NOT NULL,
          last_used_at   INTEGER NOT NULL,
          expires_at     INTEGER NOT NULL,
          revoked_at     INTEGER
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);

        -- One-time links. Only the token's hash is stored.
        CREATE TABLE registrations (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash  TEXT NOT NULL UNIQUE,
          purpose     TEXT NOT NULL CHECK (purpose IN ('bootstrap','invite','add_device')),
          role        TEXT NOT NULL CHECK (role IN ('admin','member')),
          name_hint   TEXT,
          user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
          created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          used_at     INTEGER,
          revoked_at  INTEGER
        );

        -- Who did what to accounts and credentials. Task history is task_events.
        CREATE TABLE audit_log (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id  INTEGER,
          at             INTEGER NOT NULL,
          entity         TEXT NOT NULL,
          entity_id      TEXT NOT NULL,
          action         TEXT NOT NULL,
          before_json    TEXT,
          after_json     TEXT
        );
        CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

        --------------------------------------------------------------- other actors
        -- An anonymous browser on the perimeter. The name is self-typed, shown
        -- as unverified, and never maps to a user.
        CREATE TABLE lan_devices (
          id            TEXT PRIMARY KEY,
          name          TEXT,
          created_at    INTEGER NOT NULL,
          last_seen_at  INTEGER NOT NULL
        );

        -- A named credential owned by one user. Its rights are its scopes
        -- intersected with its owner's current rights.
        CREATE TABLE agents (
          id             TEXT PRIMARY KEY,
          owner_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name           TEXT NOT NULL,
          scopes         TEXT NOT NULL, -- JSON array
          token_hash     TEXT NOT NULL UNIQUE,
          created_at     INTEGER NOT NULL,
          last_used_at   INTEGER,
          revoked_at     INTEGER,
          revoked_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX idx_agents_owner ON agents(owner_user_id);

        ------------------------------------------------------------------- tasks
        CREATE TABLE labels (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
          color        TEXT,
          created_at   INTEGER NOT NULL,
          archived_at  INTEGER
        );

        CREATE TABLE recurrences (
          id             TEXT PRIMARY KEY,
          kind           TEXT NOT NULL CHECK (kind IN ('schedule','after_completion')),
          rrule          TEXT,            -- schedule: "FREQ=MONTHLY;BYDAY=1MO"
          anchor_date    TEXT,            -- schedule: DTSTART, a wall-clock date
          interval_days  INTEGER,         -- after_completion
          created_at     INTEGER NOT NULL,
          stopped_at     INTEGER,
          CHECK ((kind = 'schedule' AND rrule IS NOT NULL AND anchor_date IS NOT NULL)
              OR (kind = 'after_completion' AND interval_days IS NOT NULL))
        );

        CREATE TABLE tasks (
          id                  TEXT PRIMARY KEY, -- UUIDv7, client-generated when offered
          title               TEXT NOT NULL,
          details             TEXT NOT NULL DEFAULT '',
          visibility          TEXT NOT NULL CHECK (visibility IN ('public','private')),
          -- Required for a private task. A public one may have none (made on site).
          owner_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_by          TEXT NOT NULL, -- actor id
          created_by_label    TEXT NOT NULL,
          due_date            TEXT,
          map_id              TEXT,
          x                   REAL,
          y                   REAL,
          zone_id             TEXT,
          location_note       TEXT,
          recurrence_id       TEXT REFERENCES recurrences(id),
          dedupe_scope        TEXT,
          dedupe_key          TEXT,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          completed_at        INTEGER,
          completed_by        TEXT,
          completed_by_label  TEXT,
          deleted_at          INTEGER,
          rev                 INTEGER NOT NULL DEFAULT 1,
          CHECK (visibility = 'public' OR owner_user_id IS NOT NULL)
        );
        CREATE INDEX idx_tasks_open ON tasks(deleted_at, completed_at, due_date);
        CREATE INDEX idx_tasks_owner ON tasks(owner_user_id);
        CREATE INDEX idx_tasks_zone ON tasks(zone_id);
        -- The rule behind "only one open occurrence exists".
        CREATE UNIQUE INDEX idx_tasks_one_open_occurrence ON tasks(recurrence_id)
          WHERE recurrence_id IS NOT NULL AND completed_at IS NULL AND deleted_at IS NULL;
        -- And behind "the sensor is still dead" updating rather than duplicating.
        CREATE UNIQUE INDEX idx_tasks_dedupe ON tasks(dedupe_scope, dedupe_key)
          WHERE dedupe_key IS NOT NULL AND completed_at IS NULL AND deleted_at IS NULL;

        CREATE TABLE task_labels (
          task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          label_id  INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, label_id)
        ) WITHOUT ROWID;
        CREATE INDEX idx_task_labels_label ON task_labels(label_id);

        CREATE TABLE task_assignees (
          task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, user_id)
        ) WITHOUT ROWID;
        CREATE INDEX idx_task_assignees_user ON task_assignees(user_id);

        CREATE TABLE task_shares (
          task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, user_id)
        ) WITHOUT ROWID;
        CREATE INDEX idx_task_shares_user ON task_shares(user_id);

        CREATE TABLE task_comments (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          body         TEXT NOT NULL,
          actor_id     TEXT NOT NULL,
          actor_label  TEXT NOT NULL,
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);

        -- Stored on disk by id; every read goes through the app.
        CREATE TABLE attachments (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          filename     TEXT NOT NULL,
          mime         TEXT NOT NULL, -- sniffed, not what the uploader claimed
          size         INTEGER NOT NULL,
          sha256       TEXT NOT NULL,
          width        INTEGER,
          height       INTEGER,
          has_thumb    INTEGER NOT NULL DEFAULT 0,
          actor_id     TEXT NOT NULL,
          actor_label  TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          deleted_at   INTEGER
        );
        CREATE INDEX idx_attachments_task ON attachments(task_id);

        -- Append-only: every change to a task is one row here, written in the
        -- same transaction as the change. The triggers below make that a fact
        -- of the database rather than a convention.
        CREATE TABLE task_events (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id       TEXT NOT NULL,
          at            INTEGER NOT NULL,
          actor_id      TEXT NOT NULL,
          actor_label   TEXT NOT NULL,
          on_behalf_of  TEXT,
          via           TEXT NOT NULL,
          type          TEXT NOT NULL,
          payload       TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_task_events_task ON task_events(task_id, id);
        CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
          BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
        CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
          BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;

        -- A mutation already applied, by the id its client gave it, so a retry
        -- (an offline queue, an agent) gets the first answer rather than a second change.
        CREATE TABLE idempotency (
          actor_id    TEXT NOT NULL,
          key         TEXT NOT NULL,
          response    TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          PRIMARY KEY (actor_id, key)
        ) WITHOUT ROWID;

        ------------------------------------------------------------ calendar feeds
        CREATE TABLE feeds (
          id             TEXT PRIMARY KEY,
          owner_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name           TEXT NOT NULL,
          token_hash     TEXT NOT NULL UNIQUE,
          scope          TEXT NOT NULL CHECK (scope IN ('public','public_and_mine','labels')),
          label_ids      TEXT NOT NULL DEFAULT '[]', -- JSON array, for scope 'labels'
          private_mode   TEXT NOT NULL DEFAULT 'off' CHECK (private_mode IN ('off','titles','full')),
          created_at     INTEGER NOT NULL,
          last_used_at   INTEGER,
          revoked_at     INTEGER
        );
        CREATE INDEX idx_feeds_owner ON feeds(owner_user_id);

        ------------------------------------------------------------- notifications
        CREATE TABLE push_subscriptions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id    TEXT,
          endpoint      TEXT NOT NULL UNIQUE,
          p256dh        TEXT NOT NULL,
          auth          TEXT NOT NULL,
          label         TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          last_sent_at  INTEGER,
          last_error    TEXT,
          failures      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_push_user ON push_subscriptions(user_id);

        CREATE TABLE notification_prefs (
          user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          prefs       TEXT NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        CREATE TABLE notification_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind        TEXT NOT NULL,
          key         TEXT NOT NULL,
          title       TEXT NOT NULL,
          body        TEXT NOT NULL,
          url         TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          -- NULL while it waits for quiet hours to end.
          sent_at     INTEGER,
          delivered   INTEGER NOT NULL DEFAULT 0,
          UNIQUE (user_id, kind, key)
        );

        -- Small durable values: how far the notifier has read task_events.
        CREATE TABLE kv (
          key    TEXT PRIMARY KEY,
          value  TEXT NOT NULL
        ) WITHOUT ROWID;
    `,
  },
];

/**
 * What a migration did, as a short hash of the text that did it. A migration
 * runs once per database, ever, so editing one that has already run would leave
 * the schema and the code disagreeing silently. The mismatch stops startup
 * instead of failing later in some unrelated query.
 */
function fingerprint(migration: Migration): string {
  return new Bun.CryptoHasher("sha256").update(migration.sql).digest("hex").slice(0, 16);
}

function runMigrations(db: Database, log: (line: string) => void): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name         TEXT PRIMARY KEY,
      applied_at   INTEGER NOT NULL,
      fingerprint  TEXT NOT NULL
    );
  `);
  const applied = new Map(
    db
      .query<{ name: string; fingerprint: string }, []>("SELECT name, fingerprint FROM migrations")
      .all()
      .map((row) => [row.name, row.fingerprint]),
  );

  for (const migration of migrations) {
    const mark = fingerprint(migration);
    if (applied.has(migration.name)) {
      if (applied.get(migration.name) !== mark) {
        throw new Error(
          `Migration ${migration.name} has been edited since this database applied it. ` +
            `Put the change in a new migration instead, and restore ${migration.name}.`,
        );
      }
      continue;
    }
    log(`[db] applying migration ${migration.name}`);
    db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO migrations (name, applied_at, fingerprint) VALUES (?, ?, ?)").run(migration.name, Date.now(), mark);
    })();
  }
}
