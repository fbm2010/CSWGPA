require('dotenv').config();
const Database = require('better-sqlite3');
const DB_PATH  = process.env.DB_PATH || './atlas_gpa.db';
let _db;
function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}
module.exports = { getDb };
