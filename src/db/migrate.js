/**
 * ATLAS GPA — Migration Runner
 * Usage: node src/db/migrate.js
 * Safe to run multiple times (idempotent).
 */
require('dotenv').config();
const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const DB_PATH     = process.env.DB_PATH || './atlas_gpa.db';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const CATALOG_PATH = path.join(__dirname, '../../data/courses_catalog.json');

console.log(`[migrate] DB: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Execute schema
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.transaction(() => {
  schema.split(';').map(s => s.trim()).filter(Boolean).forEach(stmt => {
    try { db.prepare(stmt).run(); }
    catch (e) { if (!e.message.includes('already exists')) throw e; }
  });
})();
console.log('[migrate] ✓ Schema applied');

// Seed catalog
const count = db.prepare('SELECT COUNT(*) as n FROM courses_catalog').get();
if (count.n === 0 && fs.existsSync(CATALOG_PATH)) {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO courses_catalog
      (id, course_id, display_name, canonical_name, credits,
       default_grade_scale, category, department, phase, excluded_from_gpa)
    VALUES
      (@id, @course_id, @display_name, @canonical_name, @credits,
       @default_grade_scale, @category, @department, @phase, @excluded_from_gpa)
  `);
  db.transaction(rows => rows.forEach(r => insert.run({
    ...r,
    id: crypto.randomUUID(),
    excluded_from_gpa: r.excluded_from_gpa ? 1 : 0,
  })))(catalog);
  console.log(`[migrate] ✓ Seeded ${catalog.length} courses`);
}

db.close();
console.log('[migrate] ✓ Done');
