// ── Gmail Nuke — Service Worker ──
// Handles auth, Gmail API calls, and the deletion job state machine.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CHUNK_SIZE = 500;
const DELAY_MS = 300;
const PROTECTED_LABELS = ['STARRED', 'IMPORTANT'];

// ── Auth ──

async function getToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function revokeAndRefreshToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          getToken().then(resolve).catch(reject);
        });
      } else {
        getToken().then(resolve).catch(reject);
      }
    });
  });
}

// ── Gmail API helpers ──

async function gmailFetch(endpoint, options = {}, retries = 2) {
  let token = await getToken();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${GMAIL_API}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    if (res.status === 401 && attempt < retries) {
      token = await revokeAndRefreshToken();
      continue;
    }

    if (res.status === 429 && attempt < retries) {
      await sleep(2000 * (attempt + 1));
      continue;
    }

    if (res.status === 204) return null;

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gmail API ${res.status}: ${body}`);
    }

    return res.json();
  }
}

async function listMessages(query, pageToken = null) {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(CHUNK_SIZE),
    fields: 'messages(id,labelIds),nextPageToken,resultSizeEstimate',
  });
  if (pageToken) params.set('pageToken', pageToken);
  return gmailFetch(`/messages?${params}`);
}

async function trashMessages(ids) {
  return gmailFetch('/messages/batchModify', {
    method: 'POST',
    body: JSON.stringify({
      ids,
      addLabelIds: ['TRASH'],
      removeLabelIds: ['INBOX'],
    }),
  });
}

async function permanentDeleteMessages(ids) {
  return gmailFetch('/messages/batchDelete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

// ── Safety filter ──

function filterSafe(messages) {
  if (!messages) return [];
  return messages.filter((m) => {
    const labels = m.labelIds || [];
    return !PROTECTED_LABELS.some((pl) => labels.includes(pl));
  });
}

// ── Job state machine ──

const DEFAULT_JOB = {
  status: 'idle', // idle | scanning | deleting | paused | done | error
  queries: [],
  currentQueryIndex: 0,
  currentQueryLabel: '',
  nextPageToken: null,
  allIds: [],
  deleteIndex: 0,
  scannedCount: 0,
  deletedCount: 0,
  useTrash: true,
  dryRun: false,
  error: null,
  startedAt: null,
};

async function getJob() {
  const { job } = await chrome.storage.local.get('job');
  return job || { ...DEFAULT_JOB };
}

async function saveJob(job) {
  await chrome.storage.local.set({ job });
  // Notify any open popups
  chrome.runtime.sendMessage({ type: 'job-update', job }).catch(() => {});
}

async function startJob(config) {
  const { queries, useTrash, dryRun } = config;

  const job = {
    ...DEFAULT_JOB,
    status: 'scanning',
    queries,
    useTrash,
    dryRun,
    startedAt: Date.now(),
  };

  await saveJob(job);
  startKeepAlive();
  processJob();
}

async function processJob() {
  let job = await getJob();

  if (job.status !== 'scanning' && job.status !== 'deleting') return;

  try {
    // Phase 1: Scan — collect all message IDs
    if (job.status === 'scanning') {
      while (job.currentQueryIndex < job.queries.length) {
        // Check for pause
        job = await getJob();
        if (job.status === 'paused') return;

        const q = job.queries[job.currentQueryIndex];
        job.currentQueryLabel = q.label;
        await saveJob(job);

        let pageToken = job.nextPageToken;
        let keepGoing = true;

        while (keepGoing) {
          job = await getJob();
          if (job.status === 'paused') return;

          const result = await listMessages(q.query, pageToken);

          if (result && result.messages) {
            const safe = filterSafe(result.messages);
            const newIds = safe.map((m) => m.id);

            // Deduplicate against existing IDs
            const existing = new Set(job.allIds);
            const unique = newIds.filter((id) => !existing.has(id));

            job.allIds = job.allIds.concat(unique);
            job.scannedCount = job.allIds.length;
          }

          pageToken = result?.nextPageToken || null;
          job.nextPageToken = pageToken;
          await saveJob(job);

          if (!pageToken) {
            keepGoing = false;
          } else {
            await sleep(DELAY_MS);
          }
        }

        job.currentQueryIndex++;
        job.nextPageToken = null;
        await saveJob(job);
      }

      // Done scanning — move to deleting
      if (job.dryRun) {
        job.status = 'done';
        job.deletedCount = 0;
        await saveJob(job);
        stopKeepAlive();
        return;
      }

      job.status = 'deleting';
      job.deleteIndex = 0;
      await saveJob(job);
    }

    // Phase 2: Delete in chunks
    if (job.status === 'deleting') {
      const ids = job.allIds;

      while (job.deleteIndex < ids.length) {
        job = await getJob();
        if (job.status === 'paused') return;

        const chunk = ids.slice(job.deleteIndex, job.deleteIndex + CHUNK_SIZE);

        if (chunk.length > 0) {
          if (job.useTrash) {
            await trashMessages(chunk);
          } else {
            await permanentDeleteMessages(chunk);
          }
        }

        job.deleteIndex += chunk.length;
        job.deletedCount = job.deleteIndex;
        await saveJob(job);

        await sleep(DELAY_MS);
      }

      job.status = 'done';
      await saveJob(job);
      stopKeepAlive();
    }
  } catch (err) {
    job = await getJob();
    job.status = 'error';
    job.error = err.message;
    await saveJob(job);
    stopKeepAlive();
  }
}

async function pauseJob() {
  const job = await getJob();
  if (job.status === 'scanning' || job.status === 'deleting') {
    job.status = 'paused';
    await saveJob(job);
    stopKeepAlive();
  }
}

async function resumeJob() {
  const job = await getJob();
  if (job.status === 'paused') {
    // Resume into whichever phase we were in
    job.status = job.deleteIndex > 0 || job.currentQueryIndex >= job.queries.length
      ? 'deleting'
      : 'scanning';
    await saveJob(job);
    startKeepAlive();
    processJob();
  }
}

async function cancelJob() {
  await saveJob({ ...DEFAULT_JOB });
  stopKeepAlive();
}

// ── Keep-alive alarm ──

function startKeepAlive() {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

function stopKeepAlive() {
  chrome.alarms.clear('keepAlive');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepAlive') {
    const job = await getJob();
    if (job.status === 'scanning' || job.status === 'deleting') {
      // Re-enter processJob in case the service worker restarted
      processJob();
    } else {
      stopKeepAlive();
    }
  }
});

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case 'start':
        await startJob(msg.config);
        return { ok: true };
      case 'pause':
        await pauseJob();
        return { ok: true };
      case 'resume':
        await resumeJob();
        return { ok: true };
      case 'cancel':
        await cancelJob();
        return { ok: true };
      case 'get-job':
        return await getJob();
      case 'auth-test': {
        const token = await getToken();
        return { ok: !!token };
      }
      default:
        return { error: 'Unknown message type' };
    }
  };

  handle().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true; // keep channel open for async response
});

// ── Resume incomplete jobs on service worker startup ──

(async () => {
  const job = await getJob();
  if (job.status === 'scanning' || job.status === 'deleting') {
    startKeepAlive();
    processJob();
  }
})();

// ── Utils ──

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
