'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  employees: [],
  // key: `${employeeId}|${YYYY-MM-DD}` -> { type: 'W' | 'O', note }
  rosterOverrides: {},
  snapshots: [],
  seq: 1
};

let db = null;
let writeTimer = null;

function load() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = Object.assign({}, DEFAULT_DB, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    } catch (err) {
      // Corrupt file: keep a backup instead of silently losing data.
      fs.renameSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now());
      db = JSON.parse(JSON.stringify(DEFAULT_DB));
    }
  } else {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
    flush();
  }
  return db;
}

function flush() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, 50);
}

function nextId() {
  const db = load();
  return String(db.seq++);
}

module.exports = { load, save, flush, nextId };
