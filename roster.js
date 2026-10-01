'use strict';

const repo = require('./repo');
const dates = require('./dates');

const WORKING = 'W';
const OFF = 'O';

function defaultType(dateStr) {
  return dates.isWeekend(dateStr) ? OFF : WORKING;
}

/**
 * Load every override and snapshot for a month in two queries, so the per-day lookups
 * below stay synchronous instead of hitting the database once per calendar cell.
 */
async function loadMonth(month, employeeId) {
  const [overrides, snapshots] = await Promise.all([
    repo.getOverrides(month, employeeId),
    repo.getSnapshots({ month, employeeId })
  ]);
  const byDay = new Map();
  for (const s of snapshots) byDay.set(`${s.employeeId}|${s.date}`, s);
  return { overrides, snapshots: byDay, today: dates.today() };
}

const loadDay = (dateStr, employeeId) => loadMonth(dateStr.slice(0, 7), employeeId);

/** Resolved roster entry for one employee/day, including whether it was overridden. */
function dayType(ctx, employeeId, dateStr) {
  const o = ctx.overrides.get(`${employeeId}|${dateStr}`);
  const fallback = defaultType(dateStr);
  return {
    date: dateStr,
    type: o ? o.type : fallback,
    note: (o && o.note) || '',
    overridden: Boolean(o) && o.type !== fallback,
    weekday: dates.weekday(dateStr)
  };
}

function snapshotFor(ctx, employeeId, dateStr) {
  return ctx.snapshots.get(`${employeeId}|${dateStr}`) || null;
}

/**
 * Posting status for an employee on a date.
 * Week-off days are excluded from compliance instead of counting as misses.
 */
function statusFor(ctx, employeeId, dateStr) {
  const roster = dayType(ctx, employeeId, dateStr);
  const snapshot = snapshotFor(ctx, employeeId, dateStr);
  let status;
  if (snapshot) status = 'POSTED';
  else if (roster.type === OFF) status = 'WEEK_OFF';
  else if (dateStr > ctx.today) status = 'UPCOMING';
  else status = 'NOT_POSTED';
  return { roster, snapshot, status };
}

module.exports = { WORKING, OFF, defaultType, loadMonth, loadDay, dayType, snapshotFor, statusFor };
