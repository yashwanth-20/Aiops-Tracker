'use strict';

/** JSON-file repository used for local development (same interface as repo.postgres). */

const crypto = require('crypto');
const store = require('./store');

const db = () => store.load();

async function init() {
  store.load();
}

async function listEmployees() {
  return db().employees.slice().sort((a, b) => a.name.localeCompare(b.name));
}

async function findEmployee(id) {
  return db().employees.find((e) => e.id === id) || null;
}

async function createEmployee({ name, empId, team, shift }) {
  const emp = {
    id: crypto.randomUUID(),
    name: name.trim(),
    empId: String(empId || '').trim(),
    team: String(team || '').trim(),
    shift: String(shift || '').trim(),
    active: true
  };
  db().employees.push(emp);
  store.save();
  return emp;
}

async function bulkCreateEmployees(names) {
  const existing = new Set(db().employees.map((e) => e.name.toLowerCase()));
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
  const emp = await findEmployee(id);
  if (!emp) return null;
  Object.assign(emp, patch);
  store.save();
  return emp;
}

async function deleteEmployee(id) {
  const data = db();
  const i = data.employees.findIndex((e) => e.id === id);
  if (i === -1) return null;
  const images = data.snapshots.filter((s) => s.employeeId === id && s.image).map((s) => s.image);
  data.employees.splice(i, 1);
  data.snapshots = data.snapshots.filter((s) => s.employeeId !== id);
  for (const k of Object.keys(data.rosterOverrides)) {
    if (k.startsWith(id + '|')) delete data.rosterOverrides[k];
  }
  store.save();
  return { images };
}

async function getOverrides(month, employeeId) {
  const map = new Map();
  for (const [k, v] of Object.entries(db().rosterOverrides)) {
    const [empId, day] = k.split('|');
    if (!day || !day.startsWith(month)) continue;
    if (employeeId && empId !== employeeId) continue;
    map.set(k, { type: v.type, note: v.note || '' });
  }
  return map;
}

async function setOverride(employeeId, date, type, note) {
  const k = `${employeeId}|${date}`;
  if (type === null) delete db().rosterOverrides[k];
  else db().rosterOverrides[k] = { type, note: note || '' };
  store.save();
}

async function getSnapshots({ month, date, employeeId } = {}) {
  let list = db().snapshots;
  if (month) list = list.filter((s) => s.date.startsWith(month));
  if (date) list = list.filter((s) => s.date === date);
  if (employeeId) list = list.filter((s) => s.employeeId === employeeId);
  return list.slice().sort((a, b) => (b.date + b.postedAt).localeCompare(a.date + a.postedAt));
}

async function findSnapshot(employeeId, date) {
  return db().snapshots.find((s) => s.employeeId === employeeId && s.date === date) || null;
}

async function upsertSnapshot({ employeeId, date, comment, image }) {
  const now = new Date().toISOString();
  const existing = await findSnapshot(employeeId, date);
  if (existing) {
    existing.comment = comment;
    existing.image = image;
    existing.updatedAt = now;
    store.save();
    return existing;
  }
  const snap = {
    id: crypto.randomUUID(),
    employeeId,
    date,
    comment,
    image,
    postedAt: now,
    updatedAt: now
  };
  db().snapshots.push(snap);
  store.save();
  return snap;
}

async function deleteSnapshot(id) {
  const data = db();
  const i = data.snapshots.findIndex((s) => s.id === id);
  if (i === -1) return null;
  const [removed] = data.snapshots.splice(i, 1);
  store.save();
  return removed;
}

async function purge(keepMonth) {
  const data = db();
  const stale = data.snapshots.filter((s) => !s.date.startsWith(keepMonth));
  data.snapshots = data.snapshots.filter((s) => s.date.startsWith(keepMonth));
  for (const k of Object.keys(data.rosterOverrides)) {
    const day = k.split('|')[1] || '';
    if (!day.startsWith(keepMonth)) delete data.rosterOverrides[k];
  }
  data.lastPurgedMonth = keepMonth;
  store.flush();
  return { removed: stale.length, images: stale.filter((s) => s.image).map((s) => s.image) };
}

module.exports = {
  kind: 'local',
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
