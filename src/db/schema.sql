-- ATLAS GPA — SQLite Schema
-- Idempotent: uses IF NOT EXISTS throughout

CREATE TABLE IF NOT EXISTS users (
  id                      TEXT PRIMARY KEY,
  google_id               TEXT UNIQUE,
  email                   TEXT UNIQUE NOT NULL,
  display_name            TEXT,
  avatar_url              TEXT,
  -- Frontend reads this flag to show "What year are you in HS?" popup
  needs_high_school_year  INTEGER NOT NULL DEFAULT 1,
  high_school_year        TEXT,
  preferred_import_method TEXT NOT NULL DEFAULT 'manual'
                          CHECK(preferred_import_method IN ('pdf','manual')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reportcard_imports (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method            TEXT NOT NULL CHECK(method IN ('pdf','manual')),
  original_filename TEXT,
  original_filepath TEXT,
  -- JSON array of parsed course records
  parsed_records    TEXT NOT NULL DEFAULT '[]',
  school_year       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','confirmed','rejected')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses_catalog (
  id                  TEXT PRIMARY KEY,
  course_id           TEXT UNIQUE NOT NULL,
  display_name        TEXT NOT NULL,
  canonical_name      TEXT NOT NULL,
  credits             REAL NOT NULL DEFAULT 1.0,
  default_grade_scale TEXT NOT NULL DEFAULT 'csw',
  category            TEXT,
  department          TEXT,
  phase               TEXT,
  excluded_from_gpa   INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_google     ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_imports_user_id  ON reportcard_imports(user_id);
CREATE INDEX IF NOT EXISTS idx_catalog_id       ON courses_catalog(course_id);
