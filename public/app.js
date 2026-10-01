'use strict';

const $ = (sel) => document.querySelector(sel);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS_LABEL = {
  POSTED: 'Posted',
  NOT_POSTED: 'Not Posted',
  WEEK_OFF: 'Week Off',
  UPCOMING: 'Upcoming'
};

let employees = [];

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function api(url, options) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function downloadCsv(filename, rows) {
  const csv = rows
    .map((r) => r.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function stat(n, label, cls) {
  return `<div class="stat ${cls || ''}"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`;
}

function fillEmployeeSelect(sel, keepValue) {
  const prev = keepValue ? sel.value : null;
  sel.innerHTML = employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}${e.empId ? ' (' + esc(e.empId) + ')' : ''}</option>`).join('');
  if (prev && employees.some((e) => e.id === prev)) sel.value = prev;
}

async function loadEmployees() {
  employees = await api('/api/employees');
  fillEmployeeSelect($('#postEmployee'), true);
  fillEmployeeSelect($('#rosterEmployee'), true);
}

/* ---------------- tabs ---------------- */

const refreshers = {
  eod: loadEod,
  post: loadPostForm,
  roster: loadRoster,
  monthly: loadMonthly,
  employees: renderEmployees
};

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + btn.dataset.view).classList.remove('hidden');
  refreshers[btn.dataset.view]();
});

/* ---------------- EOD report ---------------- */

let eodData = null;

async function loadEod() {
  const date = $('#eodDate').value || todayStr();
  $('#eodDate').value = date;
  eodData = await api('/api/reports/eod?date=' + encodeURIComponent(date));
  const s = eodData.summary;

  $('#eodSummary').innerHTML =
    stat(s.total, 'Employees') +
    stat(s.posted, 'Posted', 'ok') +
    stat(s.notPosted, 'Not Posted', 'bad') +
    stat(s.weekOff, 'Week Off', 'off') +
    stat(s.compliance + '%', 'Compliance');

  if (!eodData.rows.length) {
    $('#eodTable').innerHTML = '<p class="hint" style="padding:16px">No employees yet — add them in the Employees tab.</p>';
    return;
  }

  $('#eodTable').innerHTML = `<table><thead><tr>
      <th>Employee</th><th>Emp ID</th><th>Team</th><th>Roster</th><th>Status</th>
      <th>Comments</th><th>Snapshot</th><th>Posted at</th>
    </tr></thead><tbody>${eodData.rows.map(eodRow).join('')}</tbody></table>`;
}

function eodRow(r) {
  const rosterTxt = (r.rosterType === 'W' ? 'Working' : 'Week Off') + (r.rosterOverridden ? ' (edited)' : '');
  const postedAt = r.postedAt ? new Date(r.postedAt).toLocaleString() : '—';
  const shot = r.image ? `<a href="${esc(r.image)}" target="_blank" rel="noopener">View image</a>` : '—';
  return `<tr>
    <td>${esc(r.name)}</td>
    <td>${esc(r.empId || '—')}</td>
    <td>${esc(r.team || '—')}</td>
    <td>${esc(rosterTxt)}</td>
    <td><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span></td>
    <td class="comment">${esc(r.comment) || '—'}</td>
    <td>${shot}</td>
    <td>${esc(postedAt)}</td>
  </tr>`;
}

$('#eodDate').addEventListener('change', loadEod);
$('#eodToday').addEventListener('click', () => {
  $('#eodDate').value = todayStr();
  loadEod();
});
$('#eodExport').addEventListener('click', () => {
  if (!eodData) return;
  const rows = [['Employee', 'Emp ID', 'Team', 'Roster', 'Status', 'Comments', 'Snapshot Image', 'Posted At']];
  eodData.rows.forEach((r) => rows.push([
    r.name, r.empId, r.team,
    r.rosterType === 'W' ? 'Working' : 'Week Off',
    STATUS_LABEL[r.status], r.comment, r.image ? 'Yes' : 'No',
    r.postedAt ? new Date(r.postedAt).toLocaleString() : ''
  ]));
  downloadCsv(`EOD-${eodData.date}.csv`, rows);
});

/* ---------------- post snapshot (channel) ---------------- */

let pendingImage = null;   // base64 data URL waiting to be uploaded
let clearImage = false;    // user removed an already-saved image

async function loadPostForm() {
  if (!$('#postDate').value) $('#postDate').value = todayStr();
  await refreshPostContext();
  await loadFeed();
}

function showPreview(src) {
  $('#postPreviewImg').src = src;
  $('#postPreview').classList.toggle('hidden', !src);
  if (!src) $('#postPreviewImg').removeAttribute('src');
}

async function refreshPostContext() {
  const employeeId = $('#postEmployee').value;
  const date = $('#postDate').value;
  $('#postMsg').textContent = '';
  pendingImage = null;
  clearImage = false;
  if (!employeeId || !date) return;

  const report = await api(`/api/reports/eod?date=${encodeURIComponent(date)}`);
  const row = report.rows.find((r) => r.employeeId === employeeId);
  if (!row) return;

  $('#postComment').value = row.comment || '';
  showPreview(row.image || '');
  $('#postRosterHint').innerHTML = `Roster for this day: <strong>${row.rosterType === 'W' ? 'Working' : 'Week Off'}</strong>
    &nbsp;·&nbsp; Current status: <span class="badge ${row.status}">${STATUS_LABEL[row.status]}</span>`;
  $('#postDelete').classList.toggle('hidden', !row.snapshotId);
  $('#postDelete').dataset.id = row.snapshotId || '';
}

function acceptImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return false;
  const msg = $('#postMsg');
  if (file.size > 8 * 1024 * 1024) {
    msg.className = 'msg err';
    msg.textContent = 'Image is larger than 8 MB.';
    return true;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = reader.result;
    clearImage = false;
    showPreview(pendingImage);
    msg.className = 'msg ok';
    msg.textContent = 'Image pasted. Add your comment and post.';
  };
  reader.readAsDataURL(file);
  return true;
}

function imageFromClipboard(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

// Paste anywhere on the Post Snapshot tab, not just inside the drop zone.
document.addEventListener('paste', (e) => {
  if ($('#view-post').classList.contains('hidden')) return;
  const file = imageFromClipboard(e);
  if (!file) return;
  e.preventDefault();
  acceptImageFile(file);
});

$('#pasteZone').addEventListener('click', () => $('#pasteZone').focus());

$('#pasteZone').addEventListener('dragover', (e) => {
  e.preventDefault();
  $('#pasteZone').classList.add('dragover');
});
$('#pasteZone').addEventListener('dragleave', () => $('#pasteZone').classList.remove('dragover'));
$('#pasteZone').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#pasteZone').classList.remove('dragover');
  acceptImageFile(e.dataTransfer.files && e.dataTransfer.files[0]);
});

$('#postImageClear').addEventListener('click', () => {
  pendingImage = null;
  clearImage = true;
  showPreview('');
});

$('#postEmployee').addEventListener('change', refreshPostContext);
$('#postDate').addEventListener('change', refreshPostContext);

$('#postForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#postMsg');
  try {
    await api('/api/snapshots', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: $('#postEmployee').value,
        date: $('#postDate').value,
        comment: $('#postComment').value,
        image: pendingImage || undefined,
        removeImage: clearImage
      })
    });
    msg.className = 'msg ok';
    msg.textContent = 'Snapshot posted to the channel.';
    await refreshPostContext();
    await loadFeed();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  }
});

$('#postDelete').addEventListener('click', async () => {
  const id = $('#postDelete').dataset.id;
  if (!id || !confirm('Remove this posting? The day will go back to Not Posted.')) return;
  await api('/api/snapshots/' + encodeURIComponent(id), { method: 'DELETE' });
  $('#postComment').value = '';
  showPreview('');
  await refreshPostContext();
  await loadFeed();
});

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

async function loadFeed() {
  const data = await api('/api/channel');
  const monthName = new Date(data.month + '-01T00:00:00').toLocaleString(undefined, { month: 'long', year: 'numeric' });
  $('#feedRetention').textContent = `${monthName} · ${data.count} post(s). Posts are kept for the month and cleared automatically when the next month starts.`;

  if (!data.posts.length) {
    $('#feed').innerHTML = '<p class="hint">No snapshots posted this month yet.</p>';
    return;
  }

  $('#feed').innerHTML = data.posts.map((p) => `
    <article class="post">
      <div class="post-head">
        <div class="avatar">${esc(initials(p.name))}</div>
        <div>
          <div class="post-who">${esc(p.name)}${p.team ? ' · ' + esc(p.team) : ''}</div>
          <div class="post-meta">${esc(p.date)} · posted ${esc(new Date(p.postedAt).toLocaleString())}</div>
        </div>
      </div>
      ${p.comment ? `<div class="post-body">${esc(p.comment)}</div>` : ''}
      ${p.image ? `<img class="shot" src="${esc(p.image)}" alt="Snapshot by ${esc(p.name)} on ${esc(p.date)}" />` : ''}
    </article>`).join('');
}

$('#feed').addEventListener('click', (e) => {
  const img = e.target.closest('img.shot');
  if (!img) return;
  const box = document.createElement('div');
  box.className = 'lightbox';
  const big = document.createElement('img');
  big.src = img.src;
  box.appendChild(big);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
});

/* ---------------- roster calendar ---------------- */

async function loadRoster() {
  if (!employees.length) {
    $('#calendar').innerHTML = '<p class="hint">Add employees first.</p>';
    return;
  }
  if (!$('#rosterMonth').value) $('#rosterMonth').value = todayStr().slice(0, 7);
  const employeeId = $('#rosterEmployee').value || employees[0].id;
  $('#rosterEmployee').value = employeeId;
  const month = $('#rosterMonth').value;

  const data = await api(`/api/roster/${encodeURIComponent(employeeId)}?month=${encodeURIComponent(month)}`);
  renderCalendar(data);
}

function renderCalendar(data) {
  const today = todayStr();
  const first = data.days[0];
  const lead = first.weekday;

  let html = `<h2>${esc(data.employee.name)} — ${esc(data.month)}</h2><div class="cal-grid">`;
  html += DOW.map((d) => `<div class="cal-head">${d}</div>`).join('');
  for (let i = 0; i < lead; i++) html += '<div class="cal-day empty"></div>';

  for (const day of data.days) {
    const classes = ['cal-day'];
    if (day.type === 'O') classes.push('off');
    else if (day.posted) classes.push('posted');
    else if (day.date <= today) classes.push('missed');
    if (day.overridden) classes.push('edited');
    if (day.date === today) classes.push('today');

    const label = day.type === 'W' ? 'Working' : 'Week Off';
    const mark = day.type === 'W' ? (day.posted ? 'Posted' : (day.date <= today ? 'Not posted' : '')) : '';
    html += `<button class="${classes.join(' ')}" data-date="${esc(day.date)}" data-type="${esc(day.type)}"
        title="${esc(day.comment || 'Click to toggle Working / Week Off')}">
      <span class="d">${Number(day.date.slice(8))}</span>
      <span class="t">${label}</span>
      <span class="t">${esc(mark)}</span>
    </button>`;
  }
  html += '</div>';
  $('#calendar').innerHTML = html;
}

$('#calendar').addEventListener('click', async (e) => {
  const cell = e.target.closest('.cal-day');
  if (!cell || cell.classList.contains('empty')) return;
  const next = cell.dataset.type === 'W' ? 'O' : 'W';
  await api('/api/roster/' + encodeURIComponent($('#rosterEmployee').value), {
    method: 'PUT',
    body: JSON.stringify({ date: cell.dataset.date, type: next })
  });
  await loadRoster();
});

$('#rosterEmployee').addEventListener('change', loadRoster);
$('#rosterMonth').addEventListener('change', loadRoster);

$('#rosterReset').addEventListener('click', async () => {
  if (!confirm('Reset this month back to default (weekdays working, weekends off)?')) return;
  const employeeId = $('#rosterEmployee').value;
  const data = await api(`/api/roster/${encodeURIComponent(employeeId)}?month=${encodeURIComponent($('#rosterMonth').value)}`);
  for (const day of data.days) {
    if (day.overridden) {
      await api('/api/roster/' + encodeURIComponent(employeeId), {
        method: 'PUT',
        body: JSON.stringify({ date: day.date, type: null })
      });
    }
  }
  await loadRoster();
});

/* ---------------- monthly report ---------------- */

let monthlyData = null;

async function loadMonthly() {
  if (!$('#monthlyMonth').value) $('#monthlyMonth').value = todayStr().slice(0, 7);
  monthlyData = await api('/api/reports/monthly?month=' + encodeURIComponent($('#monthlyMonth').value));

  $('#monthlySummary').innerHTML =
    stat(monthlyData.totals.employees, 'Employees') +
    stat(monthlyData.totals.posted, 'Snapshots Posted', 'ok') +
    stat(monthlyData.totals.notPosted, 'Missed', 'bad') +
    stat(monthlyData.totals.weekOff, 'Week Off Days', 'off') +
    stat(monthlyData.totals.compliance + '%', 'Overall Compliance');

  if (!monthlyData.rows.length) {
    $('#monthlyTable').innerHTML = '<p class="hint" style="padding:16px">No employees yet.</p>';
    return;
  }

  const heads = monthlyData.days
    .map((d) => `<th title="${esc(d)}">${Number(d.slice(8))}</th>`)
    .join('');

  const body = monthlyData.rows.map((r) => {
    const cells = r.cells.map((c) => {
      const sym = { POSTED: '✓', NOT_POSTED: '✗', WEEK_OFF: '–', UPCOMING: '·' }[c.status];
      return `<td class="cell ${c.status}" title="${esc(c.date)}: ${STATUS_LABEL[c.status]}">${sym}</td>`;
    }).join('');
    return `<tr>
      <td>${esc(r.name)}</td>
      <td>${esc(r.team || '—')}</td>
      ${cells}
      <td>${r.posted}</td><td>${r.notPosted}</td><td>${r.weekOff}</td><td>${r.compliance}%</td>
    </tr>`;
  }).join('');

  $('#monthlyTable').innerHTML = `<table class="month-grid"><thead><tr>
      <th>Employee</th><th>Team</th>${heads}
      <th>Posted</th><th>Missed</th><th>Off</th><th>%</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

$('#monthlyMonth').addEventListener('change', loadMonthly);
$('#monthlyExport').addEventListener('click', () => {
  if (!monthlyData) return;
  const header = ['Employee', 'Emp ID', 'Team', ...monthlyData.days.map((d) => d.slice(8)), 'Posted', 'Missed', 'Week Off', 'Compliance %'];
  const rows = [header];
  monthlyData.rows.forEach((r) => rows.push([
    r.name, r.empId, r.team,
    ...r.cells.map((c) => STATUS_LABEL[c.status]),
    r.posted, r.notPosted, r.weekOff, r.compliance
  ]));
  downloadCsv(`Monthly-${monthlyData.month}.csv`, rows);
});

/* ---------------- employees ---------------- */

async function renderEmployees() {
  await loadEmployees();
  if (!employees.length) {
    $('#empTable').innerHTML = '<p class="hint" style="padding:16px">No employees yet. Use the bulk box to paste your list.</p>';
    return;
  }
  const body = employees.map((e) => `<tr data-id="${esc(e.id)}">
    <td>${esc(e.name)}</td>
    <td>${esc(e.empId || '—')}</td>
    <td>${esc(e.team || '—')}</td>
    <td>${esc(e.shift || '—')}</td>
    <td>${e.active === false ? 'Inactive' : 'Active'}</td>
    <td class="row">
      <button class="link" data-act="toggle">${e.active === false ? 'Activate' : 'Deactivate'}</button>
      <button class="link" data-act="roster">Roster</button>
      <button class="link" data-act="delete" style="color:#fca5a5">Delete</button>
    </td>
  </tr>`).join('');

  $('#empTable').innerHTML = `<table><thead><tr>
      <th>Name</th><th>Emp ID</th><th>Team</th><th>Shift</th><th>State</th><th>Actions</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

$('#empTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const emp = employees.find((x) => x.id === id);

  if (btn.dataset.act === 'delete') {
    if (!confirm(`Delete ${emp.name}? Their snapshots and roster edits will be removed.`)) return;
    await api('/api/employees/' + encodeURIComponent(id), { method: 'DELETE' });
    await renderEmployees();
  } else if (btn.dataset.act === 'toggle') {
    await api('/api/employees/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify({ active: emp.active === false })
    });
    await renderEmployees();
  } else {
    document.querySelector('.tab[data-view="roster"]').click();
    $('#rosterEmployee').value = id;
    await loadRoster();
  }
});

$('#empForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      name: $('#empName').value,
      empId: $('#empCode').value,
      team: $('#empTeam').value,
      shift: $('#empShift').value
    })
  });
  e.target.reset();
  await renderEmployees();
});

$('#bulkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const names = $('#bulkNames').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = await api('/api/employees/bulk', { method: 'POST', body: JSON.stringify({ names }) });
  $('#bulkMsg').className = 'msg ok';
  $('#bulkMsg').textContent = `${out.added} employee(s) added.`;
  $('#bulkNames').value = '';
  await renderEmployees();
});

/* ---------------- boot ---------------- */

(async function init() {
  $('#eodDate').value = todayStr();
  $('#postDate').value = todayStr();
  $('#rosterMonth').value = todayStr().slice(0, 7);
  $('#monthlyMonth').value = todayStr().slice(0, 7);
  await loadEmployees();
  await loadEod();
})();
