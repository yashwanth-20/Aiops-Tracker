'use strict';

/** Postgres-backed repository (Vercel Postgres, Neon, Supabase — any connection string). */

const { Pool } = require('pg');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// One small pool per warm lambda; serverless instances are short-lived and low-concurrency.
const pool = new Pool({
  connectionString,
  max: 1,
  idleTimeoutMillis: 10000,
  ssl: /localhost|127\.0\.0\.1/.test(connectionString || '') ? false : { rejectUnauthorized: false }
});

const q = (text, params) => pool.query(text, params);

let ready = null;

function init() {
  if (!ready) {
    ready = (async () => {
      await q(`CREATE TABLE IF NOT EXISTS employees (
        id      TEXT PRIMARY KEY,
        name    TEXT NOT NULL,
        emp_id  TEXT NOT NULL DEFAULT '',
        team    TEXT NOT NULL DEFAULT '',
        shift   TEXT NOT NULL DEFAULT '',
        active  BOOLEAN NOT NULL DEFAULT TRUE
      )`);
      await q(`CREATE TABLE IF NOT EXISTS roster_overrides (
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        day         DATE NOT NULL,
        type        CHAR(1) NOT NULL,
        note        TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (employee_id, day)
      )`);
      await q(`CREATE TABLE IF NOT EXISTS snapshots (
        id          TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        day         DATE NOT NULL,
        comment     TEXT NOT NULL DEFAULT '',
        image       TEXT NOT NULL DEFAULT '',
        posted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (employee_id, day)
      )`);
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

const mapEmployee = (r) => ({
  id: r.id, name: r.name, empId: r.emp_id, team: r.team, shift: r.shift, active: r.active
});

const mapSnapshot = (r) => ({
  id: r.id,
  employeeId: r.employee_id,
  date: r.day,
  comment: r.comment,
  image: r.image,
  postedAt: r.posted_at instanceof Date ? r.posted_at.toISOString() : r.posted_at,
  updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
});

const SNAP_COLS = `id, employee_id, to_char(day, 'YYYY-MM-DD') AS day, comment, image, posted_at, updated_at`;

/* ---------------- employees ---------------- */

async function listEmployees() {
  await init();
  const { rows } = await q('SELECT * FROM employees ORDER BY name');
  return rows.map(mapEmployee);
}

async function findEmployee(id) {
  await init();
  const { rows } = await q('SELECT * FROM employees WHERE id = $1', [id]);
  return rows[0] ? mapEmployee(rows[0]) : null;
}

async function createEmployee({ name, empId, team, shift }) {
  await init();
  const emp = {
    id: crypto.randomUUID(),
    name: name.trim(),
    empId: String(empId || '').trim(),
    team: String(team || '').trim(),
    shift: String(shift || '').trim(),
    active: true
  };
  await q(
    'INSERT INTO employees (id, name, emp_id, team, shift, active) VALUES ($1,$2,$3,$4,$5,TRUE)',
    [emp.id, emp.name, emp.empId, emp.team, emp.shift]
  );
  return emp;
}

async function bulkCreateEmployees(names) {
  await init();
  const existing = new Set((await listEmployees()).map((e) => e.name.toLowerCase()));
  const added = [];
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name || existing.has(name.toLowerCase())) continue;
    existing.add(name.toLowerCase());
    added.push(await createEmployee({ name }));
  }
  return added;
}

async function updateEmployee(id, patch) {
  await init();
  const current = await findEmployee(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  await q(
    'UPDATE employees SET name=$2, emp_id=$3, team=$4, shift=$5, active=$6 WHERE id=$1',
    [id, next.name, next.empId, next.team, next.shift, next.active]
  );
  return next;
}

async function deleteEmployee(id) {
  await init();
  const { rows } = await q(
    "SELECT image FROM snapshots WHERE employee_id = $1 AND image <> ''", [id]
  );
  const { rowCount } = await q('DELETE FROM employees WHERE id = $1', [id]);
  return rowCount ? { images: rows.map((r) => r.image) } : null;
}

/* ---------------- roster overrides ---------------- */

async function getOverrides(month, employeeId) {
  await init();
  const params = [month];
  let sql = `SELECT employee_id, to_char(day, 'YYYY-MM-DD') AS day, type, note
             FROM roster_overrides WHERE to_char(day, 'YYYY-MM') = $1`;
  if (employeeId) {
    params.push(employeeId);
    sql += ' AND employee_id = $2';
  }
  const { rows } = await q(sql, params);
  const map = new Map();
  for (const r of rows) map.set(`${r.employee_id}|${r.day}`, { type: r.type, note: r.note });
  return map;
}

async function setOverride(employeeId, date, type, note) {
  await init();
  if (type === null) {
    await q('DELETE FROM roster_overrides WHERE employee_id=$1 AND day=$2', [employeeId, date]);
    return;
  }
  await q(
    `INSERT INTO roster_overrides (employee_id, day, type, note) VALUES ($1,$2,$3,$4)
     ON CONFLICT (employee_id, day) DO UPDATE SET type = EXCLUDED.type, note = EXCLUDED.note`,
    [employeeId, date, type, note || '']
  );
}

/* ---------------- snapshots ---------------- */

async function getSnapshots({ month, date, employeeId } = {}) {
  await init();
  const where = [];
  const params = [];
  if (month) { params.push(month); where.push(`to_char(day, 'YYYY-MM') = $${params.length}`); }
  if (date) { params.push(date); where.push(`day = $${params.length}`); }
  if (employeeId) { params.push(employeeId); where.push(`employee_id = $${params.length}`); }
  const sql = `SELECT ${SNAP_COLS} FROM snapshots
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY day DESC, posted_at DESC`;
  const { rows } = await q(sql, params);
  return rows.map(mapSnapshot);
}

async function findSnapshot(employeeId, date) {
  await init();
  const { rows } = await q(
    `SELECT ${SNAP_COLS} FROM snapshots WHERE employee_id=$1 AND day=$2`, [employeeId, date]
  );
  return rows[0] ? mapSnapshot(rows[0]) : null;
}

async function upsertSnapshot({ employeeId, date, comment, image }) {
  await init();
  const { rows } = await q(
    `INSERT INTO snapshots (id, employee_id, day, comment, image)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (employee_id, day) DO UPDATE
       SET comment = EXCLUDED.comment, image = EXCLUDED.image, updated_at = NOW()
     RETURNING ${SNAP_COLS}`,
    [crypto.randomUUID(), employeeId, date, comment, image]
  );
  return mapSnapshot(rows[0]);
}

async function deleteSnapshot(id) {
  await init();
  const { rows } = await q(`DELETE FROM snapshots WHERE id = $1 RETURNING ${SNAP_COLS}`, [id]);
  return rows[0] ? mapSnapshot(rows[0]) : null;
}

/** Channel retention: drop everything outside the month being kept. */
async function purge(keepMonth) {
  await init();
  const { rows } = await q(
    `SELECT image FROM snapshots WHERE to_char(day, 'YYYY-MM') <> $1 AND image <> ''`, [keepMonth]
  );
  const { rowCount } = await q(
    `DELETE FROM snapshots WHERE to_char(day, 'YYYY-MM') <> $1`, [keepMonth]
  );
  await q(`DELETE FROM roster_overrides WHERE to_char(day, 'YYYY-MM') <> $1`, [keepMonth]);
  return { removed: rowCount, images: rows.map((r) => r.image) };
}

module.exports = {
  kind: 'postgres',
  init,
  listEmployees,
  findEmployee,
  createEmployee,
  bulkCreateEmployees,
  updateEmployee,
  deleteEmployee,
  getOverrides,
  setOverride,
  getSnapshots,
  findSnapshot,
  upsertSnapshot,
  deleteSnapshot,
  purge
};
