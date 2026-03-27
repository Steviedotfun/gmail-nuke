// ── Gmail Nuke — Popup v2 ──

const SAFETY = '-is:starred -is:important';

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function fmtBytes(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function fmtDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
}

function fmtDuration(ms) {
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return `in ${days}d`;
  if (hours > 0) return `in ${hours}h`;
  return 'soon';
}

function countClass(n) {
  if (n >= 5000) return 'extreme';
  if (n >= 1000) return 'high';
  return '';
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r)));
}

// ── Screen management ─────────────────────────────────────────────────────────

const screens = {};
document.querySelectorAll('.screen').forEach((el) => {
  screens[el.id.replace('-screen', '')] = el;
});

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name]?.classList.remove('hidden');
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const auth = await send({ type: 'auth-test' }).catch(() => null);
  if (!auth?.ok) { showScreen('auth'); return; }

  const job = await send({ type: 'get-job' });
  if (job && job.status !== 'idle' && job.status !== 'done' && job.status !== 'error') {
    renderFromJob(job);
    return;
  }

  const scan = await send({ type: 'get-scan' });
  if (scan?.status === 'done') {
    renderDashboard(scan);
  } else if (scan?.status === 'running') {
    showScreen('scanning');
    pollScan();
  } else {
    showScreen('scanning');
    await send({ type: 'scan' });
    pollScan();
  }
});

document.getElementById('auth-btn').addEventListener('click', async () => {
  const r = await send({ type: 'auth-test' });
  if (r?.ok) {
    showScreen('scanning');
    await send({ type: 'scan' });
    pollScan();
  }
});

// ── Scan polling ──────────────────────────────────────────────────────────────

let scanPoll = null;

function pollScan() {
  clearInterval(scanPoll);
  scanPoll = setInterval(async () => {
    const scan = await send({ type: 'get-scan' });
    if (!scan) return;
    if (scan.status === 'running') {
      const det = document.getElementById('scan-detail');
      if (det) det.textContent = scan.totalEmails ? `Found ${fmt(scan.totalEmails)} emails so far...` : 'Connecting to Gmail...';
    } else if (scan.status === 'done') {
      clearInterval(scanPoll);
      renderDashboard(scan);
    } else if (scan.status === 'error') {
      clearInterval(scanPoll);
      showScreen('error');
      document.getElementById('error-msg').textContent = scan.error || 'Scan failed';
    }
  }, 900);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function renderDashboard(scan) {
  showScreen('dashboard');

  // Overview
  document.getElementById('ov-total').textContent = fmt(scan.totalEmails);
  document.getElementById('ov-storage').textContent = fmtBytes(scan.totalSizeEstimate);
  document.getElementById('ov-starred').textContent = fmt(scan.starred);
  document.getElementById('ov-important').textContent = fmt(scan.important);

  // Trend from scan history
  const history = await send({ type: 'get-scan-history' });
  const trendEl = document.getElementById('ov-trend');
  if (history?.length >= 2) {
    const prev = history[history.length - 2].total;
    const curr = scan.totalEmails;
    const delta = prev - curr;
    if (delta > 0) {
      trendEl.textContent = `↓ ${fmt(delta)} from last scan`;
      trendEl.className = 'ov-trend down';
    } else if (delta < 0) {
      trendEl.textContent = `↑ ${fmt(Math.abs(delta))} since last scan`;
      trendEl.className = 'ov-trend up';
    }
  }

  // Years tab
  const yearList = document.getElementById('year-list');
  yearList.innerHTML = '';
  const currentYear = new Date().getFullYear();
  const years = Object.entries(scan.byYear).sort(([a], [b]) => Number(b) - Number(a));
  for (const [year, count] of years) {
    if (count === 0) continue;
    const autoCheck = Number(year) < currentYear - 1;
    yearList.innerHTML += `
      <label class="check-item">
        <input type="checkbox" data-query="after:${year}/01/01 before:${Number(year) + 1}/01/01 ${SAFETY}" data-label="${year}" ${autoCheck ? 'checked' : ''} />
        <span class="item-label">${year}</span>
        <span class="item-count ${countClass(count)}">~${fmt(count)}</span>
      </label>`;
  }

  // Categories tab
  const catList = document.getElementById('category-list');
  catList.innerHTML = '';
  const catQueries = {
    Promotions: 'category:promotions',
    Social: 'category:social',
    Updates: 'category:updates',
    Forums: 'category:forums',
    Spam: 'in:spam',
  };
  for (const [label, count] of Object.entries(scan.byCategory)) {
    if (count === 0) continue;
    const q = catQueries[label] || '';
    catList.innerHTML += `
      <label class="check-item">
        <input type="checkbox" data-query="${q} ${SAFETY}" data-label="${label}" checked />
        <span class="item-label">${label}</span>
        <span class="item-count ${countClass(count)}">~${fmt(count)}</span>
      </label>`;
  }

  // Senders tab
  const senderList = document.getElementById('sender-list');
  senderList.innerHTML = '';
  const sorted = Object.entries(scan.bySender)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20);

  if (sorted.length === 0) {
    senderList.innerHTML = '<div class="status-detail" style="padding:10px;color:#444">No sender data. Re-scan to load.</div>';
  }
  for (const [email, info] of sorted) {
    const displayName = info.name && info.name !== email ? info.name : '';
    const hasUnsub = !!info.unsubscribeUrl;
    const unsubUrl = escHtml(info.unsubscribeUrl || '');
    senderList.innerHTML += `
      <div class="check-item">
        <input type="checkbox" data-query="from:${email} ${SAFETY}" data-label="${escHtml(displayName || email)}" />
        <div class="sender-info">
          <div class="sender-name">${escHtml(displayName || email)}</div>
          ${displayName ? `<div class="sender-email">${escHtml(email)}</div>` : ''}
        </div>
        <div class="sender-actions">
          <span class="item-count ${countClass(info.count)}">~${fmt(info.count)}</span>
          ${hasUnsub ? `<button class="btn-tiny unsub" data-url="${unsubUrl}" onclick="unsubscribe(this)" title="Unsubscribe">Unsub</button>` : ''}
          <button class="btn-tiny del" data-query="from:${email} ${SAFETY}" data-label="${escHtml(displayName || email)}" onclick="deleteSender(this)" title="Delete all from sender">🗑</button>
        </div>
      </div>`;
  }

  // Schedule
  await loadScheduleUI();

  // Tabs
  initTabs();
}

// ── Per-sender actions (global functions for inline onclick) ──────────────────

window.unsubscribe = function (btn) {
  const url = btn.dataset.url;
  if (url) {
    send({ type: 'unsubscribe', url });
    btn.textContent = '✓';
    btn.style.color = '#4ade80';
    btn.disabled = true;
  }
};

window.deleteSender = function (btn) {
  send({
    type: 'start',
    config: {
      queries: [{ label: btn.dataset.label, query: btn.dataset.query }],
      useTrash: !document.getElementById('toggle-permanent').checked,
      dryRun: false,
    },
  });
  showScreen('running');
  startJobPoll();
};

// ── Big Files tab ─────────────────────────────────────────────────────────────

document.getElementById('load-bigfiles-btn').addEventListener('click', async () => {
  const btn = document.getElementById('load-bigfiles-btn');
  btn.textContent = 'Loading...';
  btn.disabled = true;

  const { files } = await send({ type: 'get-big-files' });
  const list = document.getElementById('bigfiles-list');
  list.innerHTML = '';

  if (!files?.length) {
    list.innerHTML = '<div class="status-detail" style="padding:10px;color:#444">No large attachments found.</div>';
    return;
  }

  for (const f of files) {
    list.innerHTML += `
      <div class="file-item">
        <input type="checkbox" class="bigfile-chk" data-id="${f.id}" checked />
        <div class="file-info">
          <div class="file-subject">${escHtml(f.subject)}</div>
          <div class="file-sender">${escHtml(f.sender)}</div>
        </div>
        <span class="file-size">${fmtBytes(f.size)}</span>
      </div>`;
  }

  document.getElementById('bigfiles-actions').style.display = 'flex';
});

document.getElementById('bigfiles-delete-btn').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('.bigfile-chk:checked')].map((c) => c.dataset.id);
  if (!checked.length) return;
  const useTrash = !document.getElementById('toggle-permanent').checked;
  await send({ type: 'start-from-ids', config: { ids: checked, useTrash } });
  showScreen('running');
  startJobPoll();
});

// ── Custom query tab ──────────────────────────────────────────────────────────

function getCustomQueries() {
  const raw = document.getElementById('custom-query').value.trim();
  if (!raw) return [];
  return raw.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Auto-append safety if not already present
      const q = line.includes('-is:starred') ? line : `${line} ${SAFETY}`;
      return { label: line.slice(0, 40), query: q };
    });
}

document.getElementById('custom-preview-btn').addEventListener('click', async () => {
  const queries = getCustomQueries();
  if (!queries.length) return;
  await send({ type: 'start', config: { queries, useTrash: true, dryRun: true } });
  showScreen('running');
  startJobPoll();
});

document.getElementById('custom-delete-btn').addEventListener('click', async () => {
  const queries = getCustomQueries();
  if (!queries.length) return;
  const useTrash = !document.getElementById('toggle-permanent').checked;
  if (!useTrash && !confirm('Permanently delete emails matching these queries?\n\nThis cannot be undone.')) return;
  await send({ type: 'start', config: { queries, useTrash, dryRun: false } });
  showScreen('running');
  startJobPoll();
});

// ── Schedule UI ───────────────────────────────────────────────────────────────

async function loadScheduleUI() {
  const schedule = await send({ type: 'get-schedule' });
  if (!schedule) return;

  document.getElementById('schedule-enabled').checked = !!schedule.enabled;
  updateScheduleBadge(schedule.enabled);

  // Frequency pills
  const freq = schedule.frequency || 'weekly';
  document.querySelectorAll('.freq-pill').forEach((p) => {
    p.classList.toggle('active', p.dataset.freq === freq);
  });

  // Category checkboxes
  if (schedule.queries?.length) {
    const enabledQueries = new Set(schedule.queries.map((q) => q.query));
    document.querySelectorAll('.sched-cat').forEach((cb) => {
      cb.checked = enabledQueries.has(cb.dataset.query);
    });
  }

  renderScheduleMeta(schedule);
}

function renderScheduleMeta(schedule) {
  const meta = document.getElementById('schedule-meta');
  if (!meta) return;
  const lines = [];
  if (schedule.lastRun) {
    lines.push(`Last run: <span>${fmtDate(schedule.lastRun)}</span>${schedule.lastRunCount != null ? ` · <span>${schedule.lastRunCount.toLocaleString()} deleted</span>` : ''}`);
  }
  if (schedule.enabled && schedule.lastRun) {
    const freqMs = { daily: 86400000, weekly: 604800000, monthly: 2592000000 }[schedule.frequency] || 604800000;
    const next = schedule.lastRun + freqMs;
    lines.push(`Next run: <span>${fmtDuration(next - Date.now())}</span>`);
  } else if (schedule.enabled && !schedule.lastRun) {
    lines.push(`Next run: <span>on next Chrome open</span>`);
  }
  meta.innerHTML = lines.join('<br>');
}

function updateScheduleBadge(enabled) {
  const badge = document.getElementById('schedule-status-badge');
  badge.textContent = enabled ? 'ON' : 'OFF';
  badge.className = `schedule-status ${enabled ? 'on' : 'off'}`;
}

// Schedule accordion toggle
document.getElementById('schedule-toggle').addEventListener('click', () => {
  const body = document.getElementById('schedule-body');
  const chevron = document.getElementById('schedule-chevron');
  const isOpen = !body.classList.contains('hidden');
  body.classList.toggle('hidden', isOpen);
  chevron.classList.toggle('open', !isOpen);
});

// Enable toggle
document.getElementById('schedule-enabled').addEventListener('change', (e) => {
  updateScheduleBadge(e.target.checked);
});

// Frequency pills
document.querySelectorAll('.freq-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.freq-pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
  });
});

// Save schedule
document.getElementById('save-schedule-btn').addEventListener('click', async () => {
  const enabled = document.getElementById('schedule-enabled').checked;
  const frequency = document.querySelector('.freq-pill.active')?.dataset.freq || 'weekly';
  const queries = [...document.querySelectorAll('.sched-cat:checked')].map((cb) => ({
    label: cb.dataset.label,
    query: cb.dataset.query,
  }));

  const schedule = await send({ type: 'save-schedule', schedule: { enabled, frequency, queries } });

  updateScheduleBadge(enabled);
  renderScheduleMeta(schedule);

  const btn = document.getElementById('save-schedule-btn');
  btn.textContent = 'Saved ✓';
  setTimeout(() => { btn.textContent = 'Save Schedule'; }, 1500);
});

// ── Tabs ──────────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab)?.classList.remove('hidden');
    });
  });
}

// ── Rescan ────────────────────────────────────────────────────────────────────

document.getElementById('rescan-btn').addEventListener('click', async () => {
  await send({ type: 'clear-scan' });
  showScreen('scanning');
  await send({ type: 'scan' });
  pollScan();
});

// ── Permanent delete toggle ───────────────────────────────────────────────────

document.getElementById('toggle-permanent').addEventListener('change', (e) => {
  const label = document.getElementById('mode-label');
  label.textContent = e.target.checked ? 'Permanent Delete' : 'Move to Trash';
  label.style.color = e.target.checked ? '#ef4444' : '';
});

// ── Collect queries from checked boxes across all content tabs ────────────────

function getSelectedQueries() {
  const queries = [];
  const seen = new Set();
  // Years, categories, senders tabs
  document.querySelectorAll('#tab-years input:checked, #tab-categories input:checked, #tab-senders input:checked').forEach((cb) => {
    const q = cb.dataset.query;
    const label = cb.dataset.label;
    if (q && !seen.has(q)) { seen.add(q); queries.push({ label, query: q }); }
  });
  return queries;
}

// ── Start / Preview ───────────────────────────────────────────────────────────

document.getElementById('start-btn').addEventListener('click', async () => {
  const queries = getSelectedQueries();
  if (!queries.length) return;
  const useTrash = !document.getElementById('toggle-permanent').checked;
  if (!useTrash && !confirm('Permanently delete these emails? This cannot be undone.')) return;
  await send({ type: 'start', config: { queries, useTrash, dryRun: false } });
  showScreen('running');
  startJobPoll();
});

document.getElementById('dry-run-btn').addEventListener('click', async () => {
  const queries = getSelectedQueries();
  if (!queries.length) return;
  await send({ type: 'start', config: { queries, useTrash: true, dryRun: true } });
  showScreen('running');
  startJobPoll();
});

// ── Job rendering ─────────────────────────────────────────────────────────────

function renderFromJob(job) {
  if (!job || job.status === 'idle') {
    send({ type: 'get-scan' }).then((scan) => {
      if (scan?.status === 'done') renderDashboard(scan);
      else { showScreen('scanning'); send({ type: 'scan' }).then(() => pollScan()); }
    });
    return;
  }

  switch (job.status) {
    case 'scanning':
    case 'deleting':
      showScreen('running');
      updateRunningUI(job);
      startJobPoll();
      break;
    case 'paused':
      showScreen('paused');
      document.getElementById('paused-scanned').textContent = fmt(job.scannedCount);
      document.getElementById('paused-deleted').textContent = fmt(job.deletedCount);
      break;
    case 'done':
      showScreen('done');
      renderDoneScreen(job);
      break;
    case 'error':
      showScreen('error');
      document.getElementById('error-msg').textContent = job.error || 'Unknown error';
      break;
  }
}

function renderDoneScreen(job) {
  if (job.dryRun) {
    document.getElementById('done-icon').textContent = '🔍';
    document.getElementById('done-title').textContent = 'Preview Complete';
    document.getElementById('done-count').textContent = `${job.scannedCount.toLocaleString()} emails would be deleted`;
    document.getElementById('done-freed').textContent = job.freedBytes ? `~${fmtBytes(job.freedBytes)} would be freed` : '';
  } else {
    document.getElementById('done-icon').textContent = '✅';
    document.getElementById('done-title').textContent = 'Done!';
    document.getElementById('done-count').textContent = `${job.deletedCount.toLocaleString()} emails deleted`;
    document.getElementById('done-freed').textContent = job.freedBytes ? `~${fmtBytes(job.freedBytes)} freed` : '';
  }

  // Breakdown
  const breakdown = document.getElementById('done-breakdown');
  breakdown.innerHTML = '';
  const counts = job.queryCounts || {};
  const sorted = Object.entries(counts).filter(([, n]) => n > 0).sort(([, a], [, b]) => b - a);
  const typeLabel = job.dryRun ? 'would delete' : 'deleted';

  for (const [label, count] of sorted) {
    breakdown.innerHTML += `
      <div class="breakdown-row">
        <span class="breakdown-label">${escHtml(label)}</span>
        <span class="breakdown-count">${count.toLocaleString()} <span class="breakdown-type">${typeLabel}</span></span>
      </div>`;
  }
}

function updateRunningUI(job) {
  document.getElementById('stat-scanned').textContent = fmt(job.scannedCount);
  document.getElementById('stat-deleted').textContent = fmt(job.deletedCount);
  document.getElementById('stat-freed').textContent = job.freedBytes ? fmtBytes(job.freedBytes) : '—';

  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('status-label');
  const detail = document.getElementById('status-detail');

  if (job.status === 'scanning') {
    label.textContent = job.dryRun ? 'Counting...' : 'Finding emails...';
    detail.textContent = job.currentQueryLabel ? `Searching: ${job.currentQueryLabel}` : '';
    fill.className = 'progress-fill scanning';
    fill.style.width = '100%';
  } else {
    label.textContent = 'Deleting...';
    const total = job.allIds?.length || 1;
    const pct = Math.min(100, Math.round((job.deletedCount / total) * 100));
    detail.textContent = `${job.deletedCount.toLocaleString()} of ${total.toLocaleString()}`;
    fill.className = 'progress-fill';
    fill.style.width = `${pct}%`;
  }
}

// ── Job polling ───────────────────────────────────────────────────────────────

let jobPoll = null;

function startJobPoll() {
  clearInterval(jobPoll);
  jobPoll = setInterval(async () => {
    const job = await send({ type: 'get-job' });
    if (!job) return;
    if (job.status === 'scanning' || job.status === 'deleting') updateRunningUI(job);
    else { clearInterval(jobPoll); renderFromJob(job); }
  }, 800);
}

// ── Pause / Resume / Cancel ───────────────────────────────────────────────────

document.getElementById('pause-btn').addEventListener('click', async () => {
  await send({ type: 'pause' });
  clearInterval(jobPoll);
  renderFromJob(await send({ type: 'get-job' }));
});

document.getElementById('resume-btn').addEventListener('click', async () => {
  await send({ type: 'resume' });
  showScreen('running');
  startJobPoll();
});

document.getElementById('cancel-btn').addEventListener('click', async () => {
  if (confirm('Cancel the current job?')) {
    await send({ type: 'cancel' });
    clearInterval(jobPoll);
    renderFromJob(null);
  }
});

document.getElementById('cancel-paused-btn').addEventListener('click', async () => {
  await send({ type: 'cancel' });
  renderFromJob(null);
});

// ── Done / Error reset ────────────────────────────────────────────────────────

document.getElementById('reset-btn').addEventListener('click', async () => {
  await send({ type: 'cancel' });
  await send({ type: 'clear-scan' });
  showScreen('scanning');
  await send({ type: 'scan' });
  pollScan();
});

document.getElementById('error-reset-btn').addEventListener('click', async () => {
  await send({ type: 'cancel' });
  renderFromJob(null);
});

// ── Live updates from service worker ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'job-update' && msg.job) renderFromJob(msg.job);
  if (msg.type === 'scan-update') {
    send({ type: 'get-scan' }).then((s) => { if (s?.status === 'done') renderDashboard(s); });
  }
});
