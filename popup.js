// ── Gmail Nuke — Popup UI ──

const QUERIES = [
  { id: 'chk-old', label: 'Pre-2024 emails', query: 'before:2024/01/01 -is:starred -is:important' },
  { id: 'chk-promos', label: 'Promotions', query: 'category:promotions -is:starred -is:important' },
  { id: 'chk-social', label: 'Social', query: 'category:social -is:starred -is:important' },
  { id: 'chk-updates', label: 'Updates', query: 'category:updates -is:starred -is:important' },
  { id: 'chk-forums', label: 'Forums', query: 'category:forums -is:starred -is:important' },
  { id: 'chk-spam', label: 'Spam', query: 'in:spam -is:starred -is:important' },
];

// ── Screens ──

const screens = {
  auth: document.getElementById('auth-screen'),
  idle: document.getElementById('idle-screen'),
  running: document.getElementById('running-screen'),
  paused: document.getElementById('paused-screen'),
  done: document.getElementById('done-screen'),
  error: document.getElementById('error-screen'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ── Format numbers ──

function fmt(n) {
  return n.toLocaleString();
}

// ── Send message to service worker ──

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
  // Check auth
  const authResult = await send({ type: 'auth-test' }).catch(() => null);

  if (!authResult || authResult.error) {
    showScreen('auth');
  } else {
    // Check for active job
    const job = await send({ type: 'get-job' });
    renderFromJob(job);
  }
});

// ── Render based on job state ──

function renderFromJob(job) {
  if (!job || job.status === 'idle') {
    showScreen('idle');
    return;
  }

  switch (job.status) {
    case 'scanning':
    case 'deleting':
      showScreen('running');
      updateRunningUI(job);
      startPolling();
      break;
    case 'paused':
      showScreen('paused');
      document.getElementById('paused-scanned').textContent = fmt(job.scannedCount);
      document.getElementById('paused-deleted').textContent = fmt(job.deletedCount);
      break;
    case 'done':
      showScreen('done');
      if (job.dryRun) {
        document.getElementById('done-title').textContent = 'Dry Run Complete';
        document.getElementById('done-count').textContent = `${fmt(job.scannedCount)} emails would be deleted`;
      } else {
        document.getElementById('done-title').textContent = 'Done!';
        document.getElementById('done-count').textContent = `${fmt(job.deletedCount)} emails deleted`;
      }
      break;
    case 'error':
      showScreen('error');
      document.getElementById('error-msg').textContent = job.error || 'Unknown error';
      break;
    default:
      showScreen('idle');
  }
}

function updateRunningUI(job) {
  const statusLabel = document.getElementById('status-label');
  const statusDetail = document.getElementById('status-detail');
  const progressFill = document.getElementById('progress-fill');
  const statScanned = document.getElementById('stat-scanned');
  const statDeleted = document.getElementById('stat-deleted');

  statScanned.textContent = fmt(job.scannedCount);
  statDeleted.textContent = fmt(job.deletedCount);

  if (job.status === 'scanning') {
    statusLabel.textContent = 'Scanning...';
    statusDetail.textContent = job.currentQueryLabel
      ? `Searching: ${job.currentQueryLabel}`
      : 'Looking for emails to delete';
    progressFill.className = 'progress-fill scanning';
    progressFill.style.width = '100%';
  } else if (job.status === 'deleting') {
    statusLabel.textContent = 'Deleting...';
    const total = job.allIds?.length || job.scannedCount || 1;
    const pct = Math.min(100, Math.round((job.deletedCount / total) * 100));
    statusDetail.textContent = `${fmt(job.deletedCount)} of ${fmt(total)}`;
    progressFill.className = 'progress-fill';
    progressFill.style.width = `${pct}%`;
  }
}

// ── Polling ──

let pollInterval = null;

function startPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    const job = await send({ type: 'get-job' });
    if (!job) return;

    if (job.status === 'scanning' || job.status === 'deleting') {
      updateRunningUI(job);
    } else {
      stopPolling();
      renderFromJob(job);
    }
  }, 800);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ── Listen for job updates from service worker ──

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'job-update' && msg.job) {
    renderFromJob(msg.job);
  }
});

// ── Toggle permanent delete ──

document.getElementById('toggle-permanent').addEventListener('change', (e) => {
  const label = document.getElementById('mode-label');
  if (e.target.checked) {
    label.textContent = '⚠️ Permanent Delete';
    label.style.color = '#ef4444';
  } else {
    label.textContent = 'Move to Trash';
    label.style.color = '';
  }
});

// ── Auth button ──

document.getElementById('auth-btn').addEventListener('click', async () => {
  const result = await send({ type: 'auth-test' });
  if (result && result.ok) {
    const job = await send({ type: 'get-job' });
    renderFromJob(job);
  }
});

// ── Get selected queries ──

function getSelectedQueries() {
  return QUERIES.filter((q) => document.getElementById(q.id).checked);
}

// ── Start button ──

document.getElementById('start-btn').addEventListener('click', async () => {
  const queries = getSelectedQueries();
  if (queries.length === 0) return;

  const useTrash = !document.getElementById('toggle-permanent').checked;

  if (!useTrash) {
    // Extra confirmation for permanent delete
    const msg = `This will PERMANENTLY delete emails. They cannot be recovered.\n\nAre you sure?`;
    if (!confirm(msg)) return;
  }

  await send({
    type: 'start',
    config: {
      queries: queries.map((q) => ({ label: q.label, query: q.query })),
      useTrash,
      dryRun: false,
    },
  });

  showScreen('running');
  startPolling();
});

// ── Dry run button ──

document.getElementById('dry-run-btn').addEventListener('click', async () => {
  const queries = getSelectedQueries();
  if (queries.length === 0) return;

  await send({
    type: 'start',
    config: {
      queries: queries.map((q) => ({ label: q.label, query: q.query })),
      useTrash: true,
      dryRun: true,
    },
  });

  showScreen('running');
  startPolling();
});

// ── Pause / Resume / Cancel ──

document.getElementById('pause-btn').addEventListener('click', async () => {
  await send({ type: 'pause' });
  const job = await send({ type: 'get-job' });
  stopPolling();
  renderFromJob(job);
});

document.getElementById('resume-btn').addEventListener('click', async () => {
  await send({ type: 'resume' });
  showScreen('running');
  startPolling();
});

document.getElementById('cancel-btn').addEventListener('click', async () => {
  if (confirm('Cancel the current job?')) {
    await send({ type: 'cancel' });
    stopPolling();
    showScreen('idle');
  }
});

document.getElementById('cancel-paused-btn').addEventListener('click', async () => {
  await send({ type: 'cancel' });
  showScreen('idle');
});

// ── Reset buttons ──

document.getElementById('reset-btn').addEventListener('click', async () => {
  await send({ type: 'cancel' });
  showScreen('idle');
});

document.getElementById('error-reset-btn').addEventListener('click', async () => {
  await send({ type: 'cancel' });
  showScreen('idle');
});
