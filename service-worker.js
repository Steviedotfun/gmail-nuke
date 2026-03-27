// ── Gmail Nuke — Service Worker ──
// Auth, Gmail API, inbox scanning, and deletion job engine.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CHUNK_SIZE = 500;
const DELAY_MS = 300;
const PROTECTED_LABELS = ['STARRED', 'IMPORTANT'];

// ── Auth ──

async function getToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
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

// ── Gmail API ──

async function gmailFetch(endpoint, options = {}, retries = 2) {
  let token = await getToken();
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${GMAIL_API}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (res.status === 401 && attempt < retries) { token = await revokeAndRefreshToken(); continue; }
    if (res.status === 429 && attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
    if (res.status === 204) return null;
    if (!res.ok) { const body = await res.text(); throw new Error(`Gmail API ${res.status}: ${body}`); }
    return res.json();
  }
}

// ── Inbox scan ──
// Fetches message metadata to build a breakdown by year, category, and sender.

async function runScan() {
  const scan = {
    status: 'running',
    totalEmails: 0,
    totalSizeEstimate: 0,
    byYear: {},        // { "2023": count, ... }
    byCategory: {},    // { "Promotions": count, ... }
    bySender: {},      // { "email@example.com": { name, count } }
    starred: 0,
    important: 0,
    error: null,
    startedAt: Date.now(),
  };
  await chrome.storage.local.set({ scan });
  startKeepAlive();

  try {
    // Get profile for total estimate
    const profile = await gmailFetch('/profile');
    scan.totalEmails = profile.messagesTotal || 0;

    // Scan categories
    const categories = [
      { label: 'Promotions', query: 'category:promotions' },
      { label: 'Social', query: 'category:social' },
      { label: 'Updates', query: 'category:updates' },
      { label: 'Forums', query: 'category:forums' },
    ];

    for (const cat of categories) {
      const result = await gmailFetch(`/messages?q=${encodeURIComponent(cat.query)}&maxResults=1&fields=resultSizeEstimate`);
      scan.byCategory[cat.label] = result?.resultSizeEstimate || 0;
      await chrome.storage.local.set({ scan });
      await sleep(100);
    }

    // Spam count
    const spamResult = await gmailFetch(`/messages?q=${encodeURIComponent('in:spam')}&maxResults=1&fields=resultSizeEstimate`);
    scan.byCategory['Spam'] = spamResult?.resultSizeEstimate || 0;

    // Starred / important counts
    const starResult = await gmailFetch(`/messages?q=${encodeURIComponent('is:starred')}&maxResults=1&fields=resultSizeEstimate`);
    scan.starred = starResult?.resultSizeEstimate || 0;
    const impResult = await gmailFetch(`/messages?q=${encodeURIComponent('is:important')}&maxResults=1&fields=resultSizeEstimate`);
    scan.important = impResult?.resultSizeEstimate || 0;

    // Scan by year — go back from current year to 2010
    const currentYear = new Date().getFullYear();
    for (let year = currentYear; year >= 2010; year--) {
      const q = `after:${year}/01/01 before:${year + 1}/01/01`;
      const result = await gmailFetch(`/messages?q=${encodeURIComponent(q)}&maxResults=1&fields=resultSizeEstimate`);
      const count = result?.resultSizeEstimate || 0;
      if (count > 0 || year >= currentYear - 2) {
        scan.byYear[String(year)] = count;
      }
      await chrome.storage.local.set({ scan });
      await sleep(100);
    }

    // Top senders — sample recent 200 messages from promotions + social + updates
    const senderQuery = '(category:promotions OR category:social OR category:updates)';
    let senderPageToken = null;
    let sampled = 0;
    const maxSample = 400;

    while (sampled < maxSample) {
      const params = new URLSearchParams({
        q: senderQuery,
        maxResults: '100',
        fields: 'messages(id),nextPageToken',
      });
      if (senderPageToken) params.set('pageToken', senderPageToken);

      const listResult = await gmailFetch(`/messages?${params}`);
      if (!listResult?.messages) break;

      // Fetch metadata for these messages (batched concurrently, 10 at a time)
      const ids = listResult.messages.map((m) => m.id);
      const batches = [];
      for (let i = 0; i < ids.length; i += 10) {
        batches.push(ids.slice(i, i + 10));
      }

      for (const batch of batches) {
        const results = await Promise.all(
          batch.map((id) =>
            gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&fields=payload/headers,sizeEstimate`)
          )
        );

        for (const msg of results) {
          if (!msg?.payload?.headers) continue;
          const fromHeader = msg.payload.headers.find((h) => h.name === 'From');
          if (!fromHeader) continue;

          const { email, name } = parseFrom(fromHeader.value);
          if (!scan.bySender[email]) {
            scan.bySender[email] = { name: name || email, count: 0, sizeEstimate: 0 };
          }
          scan.bySender[email].count++;
          scan.bySender[email].sizeEstimate += msg.sizeEstimate || 0;
        }

        sampled += batch.length;
        await sleep(100);
      }

      senderPageToken = listResult.nextPageToken;
      if (!senderPageToken) break;
      await chrome.storage.local.set({ scan });
    }

    // Get storage usage
    const storageRes = await gmailFetch('?fields=storageUsed');
    if (storageRes?.storageUsed) {
      scan.totalSizeEstimate = parseInt(storageRes.storageUsed, 10);
    }

    scan.status = 'done';
    await chrome.storage.local.set({ scan });
    stopKeepAlive();
  } catch (err) {
    scan.status = 'error';
    scan.error = err.message;
    await chrome.storage.local.set({ scan });
    stopKeepAlive();
  }

  chrome.runtime.sendMessage({ type: 'scan-update' }).catch(() => {});
}

function parseFrom(raw) {
  // "Display Name <email@example.com>" or bare "email@example.com"
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2].toLowerCase() };
  return { name: '', email: raw.trim().toLowerCase() };
}

// ── Delete job ──

const DEFAULT_JOB = {
  status: 'idle',
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
  chrome.runtime.sendMessage({ type: 'job-update', job }).catch(() => {});
}

function filterSafe(messages) {
  if (!messages) return [];
  return messages.filter((m) => {
    const labels = m.labelIds || [];
    return !PROTECTED_LABELS.some((pl) => labels.includes(pl));
  });
}

async function listMessages(query, pageToken = null) {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(CHUNK_SIZE),
    fields: 'messages(id,labelIds),nextPageToken',
  });
  if (pageToken) params.set('pageToken', pageToken);
  return gmailFetch(`/messages?${params}`);
}

async function trashMessages(ids) {
  return gmailFetch('/messages/batchModify', {
    method: 'POST',
    body: JSON.stringify({ ids, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }),
  });
}

async function permanentDeleteMessages(ids) {
  return gmailFetch('/messages/batchDelete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

async function startJob(config) {
  const job = {
    ...DEFAULT_JOB,
    status: 'scanning',
    queries: config.queries,
    useTrash: config.useTrash,
    dryRun: config.dryRun,
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
    // Phase 1: collect IDs
    if (job.status === 'scanning') {
      const idSet = new Set(job.allIds);

      while (job.currentQueryIndex < job.queries.length) {
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
          if (result?.messages) {
            for (const m of filterSafe(result.messages)) {
              idSet.add(m.id);
            }
            job.allIds = [...idSet];
            job.scannedCount = idSet.size;
          }

          pageToken = result?.nextPageToken || null;
          job.nextPageToken = pageToken;
          await saveJob(job);
          if (!pageToken) keepGoing = false;
          else await sleep(DELAY_MS);
        }

        job.currentQueryIndex++;
        job.nextPageToken = null;
        await saveJob(job);
      }

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

    // Phase 2: delete in chunks
    if (job.status === 'deleting') {
      const ids = job.allIds;
      while (job.deleteIndex < ids.length) {
        job = await getJob();
        if (job.status === 'paused') return;

        const chunk = ids.slice(job.deleteIndex, job.deleteIndex + CHUNK_SIZE);
        if (chunk.length > 0) {
          if (job.useTrash) await trashMessages(chunk);
          else await permanentDeleteMessages(chunk);
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
    job.status = job.deleteIndex > 0 || job.currentQueryIndex >= job.queries.length ? 'deleting' : 'scanning';
    await saveJob(job);
    startKeepAlive();
    processJob();
  }
}

async function cancelJob() {
  await saveJob({ ...DEFAULT_JOB });
  stopKeepAlive();
}

// ── Keep-alive ──

function startKeepAlive() { chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); }
function stopKeepAlive() { chrome.alarms.clear('keepAlive'); }

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepAlive') {
    const job = await getJob();
    if (job.status === 'scanning' || job.status === 'deleting') processJob();
    else {
      // Check if scan is running
      const { scan } = await chrome.storage.local.get('scan');
      if (!scan || scan.status !== 'running') stopKeepAlive();
    }
  }
});

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case 'start': await startJob(msg.config); return { ok: true };
      case 'pause': await pauseJob(); return { ok: true };
      case 'resume': await resumeJob(); return { ok: true };
      case 'cancel': await cancelJob(); return { ok: true };
      case 'get-job': return await getJob();
      case 'scan': runScan(); return { ok: true };
      case 'get-scan': {
        const { scan } = await chrome.storage.local.get('scan');
        return scan || null;
      }
      case 'clear-scan': await chrome.storage.local.remove('scan'); return { ok: true };
      case 'auth-test': {
        const token = await getToken();
        return { ok: !!token };
      }
      default: return { error: 'Unknown message type' };
    }
  };
  handle().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true;
});

// Resume on service worker restart
(async () => {
  const job = await getJob();
  if (job.status === 'scanning' || job.status === 'deleting') {
    startKeepAlive();
    processJob();
  }
})();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
