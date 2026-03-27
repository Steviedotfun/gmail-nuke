// ── Gmail Nuke — Popup UI ──

const SAFETY = '-is:starred -is:important';

// ── Helpers ──

function fmt(n) {
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

function countClass(n) {
  if (n >= 5000) return 'extreme';
  if (n >= 1000) return 'high';
  return '';
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// ── Screens ──

const screens = {};
document.querySelectorAll('.screen').forEach((el) => {
  screens[el.id.replace('-screen', '')] = el;
});

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name]?.classList.remove('hidden');
}

// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
  const authResult = await send({ type: 'auth-test' }).catch(() => null);
  if (!authResult?.ok) {
    showScreen('auth');
    return;
  }

  // Check for running delete job
  const job = await send({ type: 'get-job' });
  if (job && job.status !== 'idle') {
    renderFromJob(job);
    return;
  }

  // Check for existing scan
  const scan = await send({ type: 'get-scan' });
  if (scan?.status === 'done') {
    renderDashboard(scan);
  } else if (scan?.status === 'running') {
    showScreen('scanning');
    pollScan();
  } else {
    // Auto-scan on first use
    showScreen('scanning');
    await send({ type: 'scan' });
    pollScan();
  }
});

// ── Auth ──

document.getElementById('auth-btn').addEventListener('click', async () => {
  const result = await send({ type: 'auth-test' });
  if (result?.ok) {
    showScreen('scanning');
    await send({ type: 'scan' });
    pollScan();
  }
});

// ── Scan polling ──

let scanPoll = null;

function pollScan() {
  clearInterval(scanPoll);
  scanPoll = setInterval(async () => {
    const scan = await send({ type: 'get-scan' });
    if (!scan) return;

    if (scan.status === 'running') {
      document.getElementById('scan-detail').textContent =
        scan.totalEmails ? `Found ${fmt(scan.totalEmails)} emails so far...` : 'Connecting to Gmail...';
    } else if (scan.status === 'done') {
      clearInterval(scanPoll);
      renderDashboard(scan);
    } else if (scan.status === 'error') {
      clearInterval(scanPoll);
      showScreen('error');
      document.getElementById('error-msg').textContent = scan.error || 'Scan failed';
    }
  }, 800);
}

// ── Dashboard ──

function renderDashboard(scan) {
  showScreen('dashboard');

  // Overview
  document.getElementById('ov-total').textContent = fmt(scan.totalEmails);
  document.getElementById('ov-storage').textContent = fmtBytes(scan.totalSizeEstimate);
  document.getElementById('ov-starred').textContent = fmt(scan.starred);
  document.getElementById('ov-important').textContent = fmt(scan.important);

  // Years
  const yearList = document.getElementById('year-list');
  yearList.innerHTML = '';
  const years = Object.entries(scan.byYear)
    .sort(([a], [b]) => Number(b) - Number(a));

  const currentYear = new Date().getFullYear();

  for (const [year, count] of years) {
    if (count === 0) continue;
    const id = `year-${year}`;
    const checked = Number(year) < currentYear - 1 ? 'checked' : ''; // auto-check old years
    yearList.innerHTML += `
      <label class="check-item">
        <input type="checkbox" id="${id}" data-query="after:${year}/01/01 before:${Number(year) + 1}/01/01 ${SAFETY}" ${checked} />
        <span class="item-label">${year}</span>
        <span class="item-count ${countClass(count)}">~${fmt(count)}</span>
      </label>`;
  }

  // Categories
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
    const id = `cat-${label.toLowerCase()}`;
    catList.innerHTML += `
      <label class="check-item">
        <input type="checkbox" id="${id}" data-query="${q} ${SAFETY}" checked />
        <span class="item-label">${label}</span>
        <span class="item-count ${countClass(count)}">~${fmt(count)}</span>
      </label>`;
  }

  // Top senders
  const senderList = document.getElementById('sender-list');
  senderList.innerHTML = '';
  const sortedSenders = Object.entries(scan.bySender)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20);

  if (sortedSenders.length === 0) {
    senderList.innerHTML = '<div class="status-detail" style="padding:10px">No sender data yet. Re-scan for more data.</div>';
  }

  for (const [email, info] of sortedSenders) {
    const id = `sender-${email.replace(/[^a-z0-9]/g, '_')}`;
    const displayName = info.name && info.name !== email ? info.name : '';
    senderList.innerHTML += `
      <label class="check-item">
        <input type="checkbox" id="${id}" data-query="from:${email} ${SAFETY}" />
        <div style="flex:1;min-width:0">
          <div class="sender-name">${escHtml(displayName || email)}</div>
          ${displayName ? `<div class="sender-email">${escHtml(email)}</div>` : ''}
        </div>
        <span class="item-count ${countClass(info.count)}">~${fmt(info.count)}</span>
      </label>`;
  }

  // Init tabs
  initTabs();
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Tabs ──

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

// ── Re-scan ──

document.getElementById('rescan-btn').addEventListener('click', async () => {
  await send({ type: 'clear-scan' });
  showScreen('scanning');
  await send({ type: 'scan' });
  pollScan();
});

// ── Toggle permanent ──

document.getElementById('toggle-permanent').addEventListener('change', (e) => {
  const label = document.getElementById('mode-label');
  label.textContent = e.target.checked ? 'Permanent Delete' : 'Move to Trash';
  label.style.color = e.target.checked ? '#ef4444' : '';
});

// ── Collect selected queries ──

function getSelectedQueries() {
  const queries = [];
  const seen = new Set();

  document.querySelectorAll('.tab-panel input[type="checkbox"]:checked').forEach((cb) => {
    const q = cb.dataset.query;
    if (q && !seen.has(q)) {
      seen.add(q);
      // Build a label from the checkbox context
      const item = cb.closest('.check-item');
      const label = item?.querySelector('.item-label, .sender-name')?.textContent || q;
      queries.push({ label, query: q });
    }
  });

  return queries;
}

// ── Start delete ──

document.getElementById('start-btn').addEventListener('click', async () => {
  const queries = getSelectedQueries();
  if (queries.length === 0) return;

  const useTrash = !document.getElementById('toggle-permanent').checked;
  if (!useTrash && !confirm('This will PERMANENTLY delete emails. They cannot be recovered.\n\nAre you sure?')) return;

  await send({
    type: 'start',
    config: { queries, useTrash, dryRun: false },
  });
  showScreen('running');
  startJobPoll();
});

// ── Dry run / preview ──

document.getElementById('dry-run-btn').addEventListener('click', async () => {
  const queries = getSelectedQueries();
  if (queries.length === 0) return;

  await send({
    type: 'start',
    config: { queries, useTrash: true, dryRun: true },
  });
  showScreen('running');
  startJobPoll();
});

// ── Job rendering ──

function renderFromJob(job) {
  if (!job || job.status === 'idle') {
    // Go back to dashboard
    send({ type: 'get-scan' }).then((scan) => {
      if (scan?.status === 'done') renderDashboard(scan);
      else showScreen('scanning');
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
      if (job.dryRun) {
        document.getElementById('done-icon').textContent = '🔍';
        document.getElementById('done-title').textContent = 'Preview Complete';
        document.getElementById('done-count').textContent = `${job.scannedCount.toLocaleString()} emails would be deleted`;
      } else {
        document.getElementById('done-icon').textContent = '✅';
        document.getElementById('done-title').textContent = 'Done!';
        document.getElementById('done-count').textContent = `${job.deletedCount.toLocaleString()} emails deleted`;
      }
      break;
    case 'error':
      showScreen('error');
      document.getElementById('error-msg').textContent = job.error || 'Unknown error';
      break;
  }
}

function updateRunningUI(job) {
  document.getElementById('stat-scanned').textContent = fmt(job.scannedCount);
  document.getElementById('stat-deleted').textContent = fmt(job.deletedCount);

  const statusLabel = document.getElementById('status-label');
  const statusDetail = document.getElementById('status-detail');
  const progressFill = document.getElementById('progress-fill');

  if (job.status === 'scanning') {
    statusLabel.textContent = job.dryRun ? 'Counting...' : 'Finding emails...';
    statusDetail.textContent = job.currentQueryLabel ? `Searching: ${job.currentQueryLabel}` : '';
    progressFill.className = 'progress-fill scanning';
    progressFill.style.width = '100%';
  } else if (job.status === 'deleting') {
    statusLabel.textContent = 'Deleting...';
    const total = job.allIds?.length || job.scannedCount || 1;
    const pct = Math.min(100, Math.round((job.deletedCount / total) * 100));
    statusDetail.textContent = `${job.deletedCount.toLocaleString()} of ${total.toLocaleString()}`;
    progressFill.className = 'progress-fill';
    progressFill.style.width = `${pct}%`;
  }
}

// ── Job polling ──

let jobPoll = null;

function startJobPoll() {
  clearInterval(jobPoll);
  jobPoll = setInterval(async () => {
    const job = await send({ type: 'get-job' });
    if (!job) return;
    if (job.status === 'scanning' || job.status === 'deleting') {
      updateRunningUI(job);
    } else {
      clearInterval(jobPoll);
      renderFromJob(job);
    }
  }, 800);
}

// ── Pause / Resume / Cancel ──

document.getElementById('pause-btn').addEventListener('click', async () => {
  await send({ type: 'pause' });
  clearInterval(jobPoll);
  const job = await send({ type: 'get-job' });
  renderFromJob(job);
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

// ── Reset ──

document.getElementById('reset-btn').addEventListener('click', async () => {
  await send({ type: 'cancel' });
  // Trigger a re-scan to get fresh numbers
  await send({ type: 'clear-scan' });
  showScreen('scanning');
  await send({ type: 'scan' });
  pollScan();
});

document.getElementById('error-reset-btn').addEventListener('click', async () => {
  await send({ type: 'cancel' });
  renderFromJob(null);
});

// ── Listen for live updates ──

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'job-update' && msg.job) renderFromJob(msg.job);
  if (msg.type === 'scan-update') {
    send({ type: 'get-scan' }).then((scan) => {
      if (scan?.status === 'done') renderDashboard(scan);
    });
  }
});
