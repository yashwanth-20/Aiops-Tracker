'use strict';

const path = require('path');
const express = require('express');

const repo = require('./repo');
const dates = require('./dates');
const roster = require('./roster');
const storage = require('./storage');
const retention = require('./retention');

const app = express();

// Images arrive as base64 data URLs, so the body limit has to cover an 8 MB file.
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Only meaningful locally; on Vercel images live in Blob storage and are served from its CDN.
if (!storage.useBlob) {
  app.use('/uploads', express.static(storage.UPLOAD_DIR, { maxAge: '1h' }));
}

app.use('/api', (req, res, next) => {
  retention.ensureCurrentMonth().then(() => next(), next);
});

const bad = (res, msg) => res.status(400).json({ error: msg });
const missing = (res, msg) => res.status(404).json({ error: msg });

/** Wrap an async handler so rejections reach the error middleware instead of hanging. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/* ---------------- employees ---------------- */

app.get('/api/employees', wrap(async (req, res) => {
  res.json(await repo.listEmployees());
}));

app.post('/api/employees', wrap(async (req, res) => {
  const { name, empId, team, shift } = req.body || {};
  if (!name || !String(name).trim()) return bad(res, 'name is required');
  res.status(201).json(await repo.createEmployee({ name: String(name), empId, team, shift }));
}));

app.post('/api/employees/bulk', wrap(async (req, res) => {
  const { names } = req.body || {};
  if (!Array.isArray(names)) return bad(res, 'names must be an array');
  const added = await repo.bulkCreateEmployees(names);
  res.status(201).json({ added: added.length, employees: added });
}));

app.put('/api/employees/:id', wrap(async (req, res) => {
  const { name, empId, team, shift, active } = req.body || {};
  const patch = {};
  if (name !== undefined) {
    if (!String(name).trim()) return bad(res, 'name cannot be empty');
    patch.name = String(name).trim();
  }
  if (empId !== undefined) patch.empId = String(empId).trim();
  if (team !== undefined) patch.team = String(team).trim();
  if (shift !== undefined) patch.shift = String(shift).trim();
  if (active !== undefined) patch.active = Boolean(active);

  const updated = await repo.updateEmployee(req.params.id, patch);
  if (!updated) return missing(res, 'employee not found');
  res.json(updated);
}));

app.delete('/api/employees/:id', wrap(async (req, res) => {
  const result = await repo.deleteEmployee(req.params.id);
  if (!result) return missing(res, 'employee not found');
  await storage.deleteImages(result.images);
  res.json({ ok: true });
}));

/* ---------------- roster ---------------- */

app.get('/api/roster/:employeeId', wrap(async (req, res) => {
  const month = req.query.month || dates.currentMonth();
  if (!dates.isMonth(month)) return bad(res, 'month must be YYYY-MM');

  const employee = await repo.findEmployee(req.params.employeeId);
  if (!employee) return missing(res, 'employee not found');

  const ctx = await roster.loadMonth(month, employee.id);
  const days = dates.daysInMonth(month).map((date) => {
    const day = roster.dayType(ctx, employee.id, date);
    const snap = roster.snapshotFor(ctx, employee.id, date);
    return { ...day, posted: Boolean(snap), comment: snap ? snap.comment : '' };
  });
  res.json({ employee, month, days });
}));

app.put('/api/roster/:employeeId', wrap(async (req, res) => {
  const { date, type, note } = req.body || {};
  if (!dates.isDate(date)) return bad(res, 'date must be YYYY-MM-DD');
  if (type !== null && type !== roster.WORKING && type !== roster.OFF) {
    return bad(res, "type must be 'W', 'O' or null to reset");
  }
  if (!(await repo.findEmployee(req.params.employeeId))) return missing(res, 'employee not found');

  await repo.setOverride(req.params.employeeId, date, type, note);
  const ctx = await roster.loadDay(date, req.params.employeeId);
  res.json(roster.dayType(ctx, req.params.employeeId, date));
}));

/* ---------------- snapshots ---------------- */

app.get('/api/snapshots', wrap(async (req, res) => {
  const { date, month, employeeId } = req.query;
  if (date && !dates.isDate(date)) return bad(res, 'date must be YYYY-MM-DD');
  if (month && !dates.isMonth(month)) return bad(res, 'month must be YYYY-MM');
  res.json(await repo.getSnapshots({ date, month, employeeId }));
}));

app.post('/api/snapshots', wrap(async (req, res) => {
  const { employeeId, date, comment, image, removeImage } = req.body || {};
  if (!dates.isDate(date)) return bad(res, 'date must be YYYY-MM-DD');
  if (date.slice(0, 7) !== dates.currentMonth()) {
    return bad(res, 'snapshots can only be posted for the current month');
  }
  if (!(await repo.findEmployee(employeeId))) return missing(res, 'employee not found');

  const existing = await repo.findSnapshot(employeeId, date);
  let imageUrl = existing ? existing.image : '';

  try {
    if (image) {
      imageUrl = await storage.saveImage(image, date.slice(0, 7), `${employeeId}-${date}`);
    } else if (removeImage) {
      imageUrl = '';
    }
  } catch (err) {
    return bad(res, err.message);
  }

  const saved = await repo.upsertSnapshot({
    employeeId,
    date,
    comment: String(comment || ''),
    image: imageUrl
  });

  if (existing && existing.image && existing.image !== imageUrl) {
    await storage.deleteImage(existing.image);
  }
  res.status(existing ? 200 : 201).json(saved);
}));

app.delete('/api/snapshots/:id', wrap(async (req, res) => {
  const removed = await repo.deleteSnapshot(req.params.id);
  if (!removed) return missing(res, 'snapshot not found');
  await storage.deleteImage(removed.image);
  res.json({ ok: true });
}));

/** Channel feed: every post for a month, newest first, with author details. */
app.get('/api/channel', wrap(async (req, res) => {
  const month = req.query.month || dates.currentMonth();
  if (!dates.isMonth(month)) return bad(res, 'month must be YYYY-MM');

  const [employees, snapshots] = await Promise.all([
    repo.listEmployees(),
    repo.getSnapshots({ month })
  ]);
  const byId = new Map(employees.map((e) => [e.id, e]));

  const posts = snapshots.map((s) => {
    const emp = byId.get(s.employeeId);
    return {
      id: s.id,
      employeeId: s.employeeId,
      name: emp ? emp.name : 'Unknown',
      team: emp ? emp.team : '',
      date: s.date,
      comment: s.comment,
      image: s.image || '',
      postedAt: s.postedAt,
      updatedAt: s.updatedAt
    };
  });

  res.json({ month, retainedUntilEndOf: dates.currentMonth(), count: posts.length, posts });
}));

/* ---------------- reports ---------------- */

app.get('/api/reports/eod', wrap(async (req, res) => {
  const date = req.query.date || dates.today();
  if (!dates.isDate(date)) return bad(res, 'date must be YYYY-MM-DD');

  const employees = (await repo.listEmployees()).filter((e) => e.active !== false);
  const ctx = await roster.loadDay(date);

  const rows = employees.map((emp) => {
    const { roster: r, snapshot, status } = roster.statusFor(ctx, emp.id, date);
    return {
      employeeId: emp.id,
      name: emp.name,
      empId: emp.empId,
      team: emp.team,
      rosterType: r.type,
      rosterOverridden: r.overridden,
      status,
      comment: snapshot ? snapshot.comment : '',
      image: snapshot ? snapshot.image || '' : '',
      postedAt: snapshot ? snapshot.postedAt : null,
      snapshotId: snapshot ? snapshot.id : null
    };
  });

  const summary = {
    total: rows.length,
    posted: rows.filter((r) => r.status === 'POSTED').length,
    notPosted: rows.filter((r) => r.status === 'NOT_POSTED').length,
    weekOff: rows.filter((r) => r.status === 'WEEK_OFF').length
  };
  const expected = summary.posted + summary.notPosted;
  summary.compliance = expected ? Math.round((summary.posted / expected) * 100) : 100;

  res.json({ date, summary, rows });
}));

app.get('/api/reports/monthly', wrap(async (req, res) => {
  const month = req.query.month || dates.currentMonth();
  if (!dates.isMonth(month)) return bad(res, 'month must be YYYY-MM');

  const days = dates.daysInMonth(month);
  const employees = (await repo.listEmployees()).filter((e) => e.active !== false);
  const ctx = await roster.loadMonth(month);

  const rows = employees.map((emp) => {
    const cells = days.map((d) => ({ date: d, status: roster.statusFor(ctx, emp.id, d).status }));
    const posted = cells.filter((c) => c.status === 'POSTED').length;
    const notPosted = cells.filter((c) => c.status === 'NOT_POSTED').length;
    const weekOff = cells.filter((c) => c.status === 'WEEK_OFF').length;
    const expected = posted + notPosted;
    return {
      employeeId: emp.id,
      name: emp.name,
      empId: emp.empId,
      team: emp.team,
      cells,
      posted,
      notPosted,
      weekOff,
      workingDays: cells.length - weekOff,
      compliance: expected ? Math.round((posted / expected) * 100) : 100
    };
  });

  const totals = rows.reduce((acc, r) => {
    acc.posted += r.posted;
    acc.notPosted += r.notPosted;
    acc.weekOff += r.weekOff;
    return acc;
  }, { posted: 0, notPosted: 0, weekOff: 0 });
  totals.employees = rows.length;
  const expected = totals.posted + totals.notPosted;
  totals.compliance = expected ? Math.round((totals.posted / expected) * 100) : 100;

  res.json({ month, days, today: dates.today(), totals, rows });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'unknown endpoint' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

module.exports = app;
