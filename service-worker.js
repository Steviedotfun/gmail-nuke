// ── Gmail Nuke — Service Worker v2 ──

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CHUNK_SIZE = 500;
const DELAY_MS = 300;
const PROTECTED_LABELS = ['STARRED', 'IMPORTANT'];

// ── Auth ──────────────────────────────────────────────────────────────────────

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

// ── Gmail API ─────────────────────────────────────────────────────────────────

async function gmailFetch(endpoint, options = {}, retries = 4) {
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
    if ((res.status === 429 || res.status === 500 || res.status === 503) && attempt < retries) {
      await sleep(2000 * (attempt + 1)); continue;
    }
    if (res.status === 204) return null;
    if (!res.ok) { const body = await res.text(); throw new Error(`Gmail API ${res.status}: ${body}`); }
    return res.json();
  }
}

async function listMessages(query, pageToken = null) {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(CHUNK_SIZE),
    fields: 'messages(id,labelIds,sizeEstimate),nextPageToken',
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

function filterSafe(messages) {
  if (!messages) return [];
  return messages.filter((m) => {
    const labels = m.labelIds || [];
    return !PROTECTED_LABELS.some((pl) => labels.includes(pl));
  });
}

function parseFrom(raw) {
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2].toLowerCase() };
  return { name: '', email: raw.trim().toLowerCase() };
}

// ── Inbox Scan ────────────────────────────────────────────────────────────────

async function runScan() {
  const scan = {
    status: 'running',
    totalEmails: 0,
    totalSizeEstimate: 0,
    byYear: {},
    byCategory: {},
    bySender: {},
    starred: 0,
    important: 0,
    error: null,
    startedAt: Date.now(),
  };
  await chrome.storage.local.set({ scan });
  startKeepAlive();

  try {
    const profile = await gmailFetch('/profile');
    scan.totalEmails = profile?.messagesTotal || 0;

    // Category counts
    const categories = [
      { label: 'Promotions', query: 'category:promotions' },
      { label: 'Social', query: 'category:social' },
      { label: 'Updates', query: 'category:updates' },
      { label: 'Forums', query: 'category:forums' },
      { label: 'Spam', query: 'in:spam' },
    ];
    for (const cat of categories) {
      const r = await gmailFetch(`/messages?q=${encodeURIComponent(cat.query)}&maxResults=1&fields=resultSizeEstimate`);
      scan.byCategory[cat.label] = r?.resultSizeEstimate || 0;
      await chrome.storage.local.set({ scan });
      await sleep(120);
    }

    // Starred / important
    const [starR, impR] = await Promise.all([
      gmailFetch(`/messages?q=is:starred&maxResults=1&fields=resultSizeEstimate`),
      gmailFetch(`/messages?q=is:important&maxResults=1&fields=resultSizeEstimate`),
    ]);
    scan.starred = starR?.resultSizeEstimate || 0;
    scan.important = impR?.resultSizeEstimate || 0;

    // Year counts
    const currentYear = new Date().getFullYear();
    for (let year = currentYear; year >= 2010; year--) {
      const q = `after:${year}/01/01 before:${year + 1}/01/01`;
      const r = await gmailFetch(`/messages?q=${encodeURIComponent(q)}&maxResults=1&fields=resultSizeEstimate`);
      const count = r?.resultSizeEstimate || 0;
      if (count > 0 || year >= currentYear - 2) scan.byYear[String(year)] = count;
      await chrome.storage.local.set({ scan });
      await sleep(120);
    }

    // Top senders — sample from junk, collect List-Unsubscribe headers
    const senderQuery = '(category:promotions OR category:social OR category:updates)';
    let senderPageToken = null;
    let sampled = 0;

    while (sampled < 500) {
      const params = new URLSearchParams({ q: senderQuery, maxResults: '100', fields: 'messages(id),nextPageToken' });
      if (senderPageToken) params.set('pageToken', senderPageToken);
      const listResult = await gmailFetch(`/messages?${params}`);
      if (!listResult?.messages) break;

      const ids = listResult.messages.map((m) => m.id);
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        const results = await Promise.all(
          batch.map((id) =>
            gmailFetch(
              `/messages/${id}?format=metadata` +
              `&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post` +
              `&fields=payload/headers,sizeEstimate`
            )
          )
        );

        for (const msg of results) {
          if (!msg?.payload?.headers) continue;
          const h = msg.payload.headers;
          const fromHeader = h.find((x) => x.name === 'From');
          if (!fromHeader) continue;
          const { email, name } = parseFrom(fromHeader.value);

          if (!scan.bySender[email]) {
            scan.bySender[email] = { name: name || email, count: 0, sizeEstimate: 0, unsubscribeUrl: null };
          }
          scan.bySender[email].count++;
          scan.bySender[email].sizeEstimate += msg.sizeEstimate || 0;

          // Parse List-Unsubscribe
          if (!scan.bySender[email].unsubscribeUrl) {
            const unsubHeader = h.find((x) => x.name === 'List-Unsubscribe');
            if (unsubHeader) {
              scan.bySender[email].unsubscribeUrl = parseUnsubscribe(unsubHeader.value);
            }
          }
        }

        sampled += batch.length;
        await sleep(80);
      }

      senderPageToken = listResult.nextPageToken;
      if (!senderPageToken) break;
      await chrome.storage.local.set({ scan });
    }

    // Storage used (Drive API, Gmail is included)
    try {
      const token = await getToken();
      const storageRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (storageRes.ok) {
        const data = await storageRes.json();
        scan.totalSizeEstimate = parseInt(data?.storageQuota?.usage || 0, 10);
      }
    } catch (_) { /* storage info optional */ }

    scan.status = 'done';
    await chrome.storage.local.set({ scan });

    // Save scan history (last 5)
    const { scanHistory = [] } = await chrome.storage.local.get('scanHistory');
    scanHistory.push({ date: Date.now(), total: scan.totalEmails });
    await chrome.storage.local.set({ scanHistory: scanHistory.slice(-5) });

    stopKeepAlive();
    chrome.runtime.sendMessage({ type: 'scan-update' }).catch(() => {});
  } catch (err) {
    scan.status = 'error';
    scan.error = err.message;
    await chrome.storage.local.set({ scan });
    stopKeepAlive();
    chrome.runtime.sendMessage({ type: 'scan-update' }).catch(() => {});
  }
}

function parseUnsubscribe(raw) {
  // Prefer HTTPS link, fall back to mailto
  const httpsMatch = raw.match(/<(https?:\/\/[^>]+)>/i);
  if (httpsMatch) return httpsMatch[1];
  const mailtoMatch = raw.match(/<(mailto:[^>]+)>/i);
  if (mailtoMatch) return mailtoMatch[1];
  return null;
}

// ── Big Files ─────────────────────────────────────────────────────────────────

async function getBigFiles() {
  const result = await listMessages('has:attachment larger:2mb -is:starred -is:important');
  if (!result?.messages) return { files: [] };

  const ids = result.messages.slice(0, 40).map((m) => m.id);
  const details = await Promise.all(
    ids.map((id) =>
      gmailFetch(
        `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From` +
        `&fields=id,sizeEstimate,payload/headers`
      ).catch(() => null)
    )
  );

  const files = details
    .filter(Boolean)
    .map((m) => {
      const headers = m.payload?.headers || [];
      const subject = headers.find((h) => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find((h) => h.name === 'From')?.value || '';
      const { name, email } = parseFrom(from);
      return { id: m.id, size: m.sizeEstimate || 0, subject, sender: name || email };
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 20);

  return { files };
}

// ── Delete Job ────────────────────────────────────────────────────────────────

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
  freedBytes: 0,
  queryCounts: {},
  useTrash: true,
  dryRun: false,
  isAutoClean: false,
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

async function startJob(config) {
  const job = {
    ...DEFAULT_JOB,
    status: 'scanning',
    queries: config.queries,
    useTrash: config.useTrash !== false,
    dryRun: config.dryRun || false,
    isAutoClean: config.isAutoClean || false,
    startedAt: Date.now(),
  };
  await saveJob(job);
  startKeepAlive();
  processJob();
}

async function startJobFromIds(config) {
  // Skip scanning phase — go straight to deleting specific IDs
  const job = {
    ...DEFAULT_JOB,
    status: 'deleting',
    allIds: config.ids,
    scannedCount: config.ids.length,
    useTrash: config.useTrash !== false,
    queryCounts: { 'Large attachments': config.ids.length },
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

        const sizeBefore = idSet.size;
        let pageToken = job.nextPageToken;

        while (true) {
          job = await getJob();
          if (job.status === 'paused') return;

          const result = await listMessages(q.query, pageToken);
          if (result?.messages) {
            for (const m of filterSafe(result.messages)) {
              if (!idSet.has(m.id)) {
                idSet.add(m.id);
                job.freedBytes = (job.freedBytes || 0) + (m.sizeEstimate || 0);
              }
            }
            job.allIds = [...idSet];
            job.scannedCount = idSet.size;
          }

          pageToken = result?.nextPageToken || null;
          job.nextPageToken = pageToken;
          await saveJob(job);
          if (!pageToken) break;
          await sleep(DELAY_MS);
        }

        // Record per-query count
        job.queryCounts[q.label] = (job.queryCounts[q.label] || 0) + (idSet.size - sizeBefore);
        job.currentQueryIndex++;
        job.nextPageToken = null;
        await saveJob(job);
      }

      if (job.dryRun) {
        job.status = 'done';
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

      // Update schedule stats if this was an auto-clean
      if (job.isAutoClean) {
        const { schedule } = await chrome.storage.local.get('schedule');
        if (schedule) {
          schedule.lastRunCount = job.deletedCount;
          await chrome.storage.local.set({ schedule });
        }
        // Notify user
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Gmail Nuke — Auto Clean Done',
          message: `Deleted ${job.deletedCount.toLocaleString()} emails automatically.`,
        });
      }
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

// ── Auto Clean Schedule ───────────────────────────────────────────────────────

const FREQ_MS = {
  daily: 86400000,
  weekly: 604800000,
  monthly: 2592000000,
};

async function checkAndRunSchedule() {
  const { schedule } = await chrome.storage.local.get('schedule');
  if (!schedule?.enabled || !schedule?.queries?.length) return;

  const now = Date.now();
  const freqMs = FREQ_MS[schedule.frequency] || FREQ_MS.weekly;
  if (schedule.lastRun && now - schedule.lastRun < freqMs) return;

  // Don't interrupt a running job
  const job = await getJob();
  if (job.status !== 'idle' && job.status !== 'done' && job.status !== 'error') return;

  schedule.lastRun = now;
  await chrome.storage.local.set({ schedule });

  await startJob({
    queries: schedule.queries,
    useTrash: schedule.useTrash !== false,
    dryRun: false,
    isAutoClean: true,
  });
}

async function saveSchedule(config) {
  const { schedule: existing = {} } = await chrome.storage.local.get('schedule');
  const schedule = { ...existing, ...config };
  await chrome.storage.local.set({ schedule });

  if (schedule.enabled) {
    chrome.alarms.create('autoCleanCheck', { periodInMinutes: 60 });
  } else {
    chrome.alarms.clear('autoCleanCheck');
  }
  return schedule;
}

// ── Unsubscribe Scanner ───────────────────────────────────────────────────────

async function scanUnsubscribable() {
  const state = { status: 'running', senders: {}, scanned: 0, error: null };
  await chrome.storage.local.set({ unsubScan: state });
  startKeepAlive();

  try {
    // Seed from existing scan data if available
    const { scan } = await chrome.storage.local.get('scan');
    if (scan?.bySender) {
      for (const [email, info] of Object.entries(scan.bySender)) {
        if (info.unsubscribeUrl) {
          state.senders[email] = {
            email,
            name: info.name,
            count: info.count,
            unsubscribeUrl: info.unsubscribeUrl,
            method: classifyMethod(info.unsubscribeUrl, null),
            status: 'pending',
          };
        }
      }
    }

    // Deep scan: paginate through subscription-heavy categories
    const query = '(category:promotions OR category:social OR category:updates) -is:starred';
    let pageToken = null;
    let totalScanned = 0;
    const MAX_SCAN = 3000;

    while (totalScanned < MAX_SCAN) {
      const params = new URLSearchParams({
        q: query, maxResults: '100', fields: 'messages(id),nextPageToken',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const listResult = await gmailFetch(`/messages?${params}`);
      if (!listResult?.messages?.length) break;

      const ids = listResult.messages.map((m) => m.id);

      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        const results = await Promise.all(
          batch.map((id) =>
            gmailFetch(
              `/messages/${id}?format=metadata` +
              `&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post` +
              `&fields=payload/headers`
            ).catch(() => null)
          )
        );

        for (const msg of results) {
          if (!msg?.payload?.headers) continue;
          const h = msg.payload.headers;
          const fromHdr = h.find((x) => x.name === 'From');
          const unsubHdr = h.find((x) => x.name === 'List-Unsubscribe');
          const postHdr = h.find((x) => x.name === 'List-Unsubscribe-Post');
          if (!fromHdr || !unsubHdr) continue;

          const { email, name } = parseFrom(fromHdr.value);
          const url = parseUnsubscribe(unsubHdr.value);
          if (!url) continue;

          if (!state.senders[email]) {
            state.senders[email] = {
              email, name, count: 0,
              unsubscribeUrl: url,
              method: classifyMethod(url, postHdr?.value),
              status: 'pending',
            };
          }
          state.senders[email].count++;
        }

        totalScanned += batch.length;
        state.scanned = totalScanned;
        await chrome.storage.local.set({ unsubScan: state });
        await sleep(80);
      }

      pageToken = listResult.nextPageToken;
      if (!pageToken) break;
      await sleep(150);
    }

    state.status = 'done';
    await chrome.storage.local.set({ unsubScan: state });
    stopKeepAlive();
    chrome.runtime.sendMessage({ type: 'unsub-scan-done' }).catch(() => {});
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    await chrome.storage.local.set({ unsubScan: state });
    stopKeepAlive();
    chrome.runtime.sendMessage({ type: 'unsub-scan-done' }).catch(() => {});
  }
}

function classifyMethod(url, postHeader) {
  if (!url) return 'unknown';
  if (url.startsWith('mailto:')) return 'mailto';
  if (postHeader?.includes('One-Click')) return 'one-click';
  return 'http';
}

// ── Unsubscribe Executor ──────────────────────────────────────────────────────

async function executeUnsubscribes(emails) {
  // emails = array of { email, unsubscribeUrl, method, name }
  const { unsubScan } = await chrome.storage.local.get('unsubScan');

  for (const sender of emails) {
    let newStatus = 'error';
    try {
      const { url, method } = { url: sender.unsubscribeUrl, method: sender.method };

      if (method === 'one-click' && url?.startsWith('http')) {
        // RFC 8058 — silent automated POST, no tab needed
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
        });
        newStatus = (res.ok || res.status < 500) ? 'done' : 'error';
      } else if (url?.startsWith('http')) {
        // HTTP link — open in background tab
        chrome.tabs.create({ url, active: false });
        newStatus = 'opened';
      } else if (url?.startsWith('mailto:')) {
        // Open mailto — user's mail client or Gmail compose handles it
        chrome.tabs.create({ url, active: false });
        newStatus = 'opened';
      }
    } catch (_) {
      newStatus = 'error';
    }

    // Persist status
    if (unsubScan?.senders?.[sender.email]) {
      unsubScan.senders[sender.email].status = newStatus;
      await chrome.storage.local.set({ unsubScan });
    }

    chrome.runtime.sendMessage({
      type: 'unsub-progress',
      email: sender.email,
      status: newStatus,
    }).catch(() => {});

    await sleep(400);
  }

  chrome.runtime.sendMessage({ type: 'unsub-done' }).catch(() => {});
}

// ── Keep-alive ────────────────────────────────────────────────────────────────

function startKeepAlive() { chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); }
function stopKeepAlive() { chrome.alarms.clear('keepAlive'); }

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepAlive') {
    const job = await getJob();
    if (job.status === 'scanning' || job.status === 'deleting') processJob();
    else {
      const { scan } = await chrome.storage.local.get('scan');
      if (!scan || scan.status !== 'running') stopKeepAlive();
    }
  }
  if (alarm.name === 'autoCleanCheck') {
    await checkAndRunSchedule();
  }
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case 'start': await startJob(msg.config); return { ok: true };
      case 'start-from-ids': await startJobFromIds(msg.config); return { ok: true };
      case 'pause': await pauseJob(); return { ok: true };
      case 'resume': await resumeJob(); return { ok: true };
      case 'cancel': await cancelJob(); return { ok: true };
      case 'get-job': return await getJob();
      case 'scan': runScan(); return { ok: true };
      case 'get-scan': { const { scan } = await chrome.storage.local.get('scan'); return scan || null; }
      case 'clear-scan': await chrome.storage.local.remove('scan'); return { ok: true };
      case 'get-big-files': return await getBigFiles();
      case 'save-schedule': return await saveSchedule(msg.schedule);
      case 'get-schedule': { const { schedule } = await chrome.storage.local.get('schedule'); return schedule || null; }
      case 'get-scan-history': { const { scanHistory } = await chrome.storage.local.get('scanHistory'); return scanHistory || []; }
      case 'unsubscribe':
        if (msg.url) chrome.tabs.create({ url: msg.url });
        return { ok: true };
      case 'scan-unsub': scanUnsubscribable(); return { ok: true };
      case 'get-unsub-scan': { const { unsubScan } = await chrome.storage.local.get('unsubScan'); return unsubScan || null; }
      case 'clear-unsub-scan': await chrome.storage.local.remove('unsubScan'); return { ok: true };
      case 'execute-unsubs': executeUnsubscribes(msg.senders); return { ok: true };
      case 'auth-test': { const token = await getToken(); return { ok: !!token }; }
      default: return { error: 'Unknown message type' };
    }
  };
  handle().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true;
});

// Resume on startup
(async () => {
  const job = await getJob();
  if (job.status === 'scanning' || job.status === 'deleting') {
    startKeepAlive();
    processJob();
  }
  // Re-register auto-clean alarm if schedule is enabled
  const { schedule } = await chrome.storage.local.get('schedule');
  if (schedule?.enabled) {
    chrome.alarms.create('autoCleanCheck', { periodInMinutes: 60 });
  }
})();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
