# Gmail Nuke

A Chrome extension that scans your entire Gmail inbox and mass deletes old and junk emails — while always protecting your starred and important ones.

No subscription. No backend. Everything runs in your browser.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-red?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License MIT](https://img.shields.io/badge/License-MIT-green)

## Features

**Inbox Scanner** — Scans your entire inbox and shows you:
- Total email count and storage used
- Breakdown by year (2010–present)
- Breakdown by category (Promotions, Social, Updates, Forums, Spam)
- Top 20 senders from junk categories

**Year-Based Deletion** — Pick exactly which years to nuke. Old years are pre-selected for you.

**Category Cleanup** — Delete all Promotions, Social, Updates, Forums, or Spam with one click.

**Sender Cleanup** — See your top junk senders, check the ones you want gone.

**Safety First**
- Starred and Important emails are **always excluded** from every query (server-side)
- Client-side double-check on every email's labels before deletion
- Preview mode counts emails before deleting anything
- Default mode moves to Trash (recoverable for 30 days)
- Permanent delete requires an explicit toggle + confirmation

**Reliable**
- Survives Chrome restarts — saves progress after every batch
- Pause, resume, or cancel any running job
- Handles Gmail API rate limits with automatic backoff

## Setup (5 minutes)

### 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g., "gmail-nuke")
3. Enable the **Gmail API**: APIs & Services → Library → search "Gmail API" → Enable

### 2. Create OAuth credentials

1. APIs & Services → **OAuth consent screen**:
   - User type: **External**
   - App name: "Gmail Nuke"
   - Add your email as a **test user**
   - Add scopes: `gmail.readonly` and `gmail.modify`
2. APIs & Services → Credentials → **Create Credentials** → **OAuth client ID**:
   - Application type: **Chrome Extension**
   - Item ID: (get this from step 3 first, then come back)

### 3. Load the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this folder
4. Copy the **extension ID** from the card

### 4. Finish OAuth setup

1. Go back to Google Cloud → Credentials → edit your OAuth client
2. Paste the **extension ID** into the Item ID field
3. Copy the **Client ID** (`...apps.googleusercontent.com`)
4. Open `manifest.json` → replace `YOUR_CLIENT_ID.apps.googleusercontent.com` with your Client ID
5. Back to `chrome://extensions` → click refresh on Gmail Nuke

### 5. Use it

1. Click the Gmail Nuke icon in your toolbar
2. Sign in when prompted (click "Advanced" → "Go to Gmail Nuke" on the warning)
3. The inbox scan runs automatically
4. Use the dashboard tabs to select what to delete
5. Hit **Preview** to count, or **Delete Selected** to go

## How protection works

Every single query sent to Gmail includes `-is:starred -is:important`. This tells Gmail's API to **never return** those emails in results. On top of that, before any batch delete, the extension checks each message's `labelIds` — if `STARRED` or `IMPORTANT` is present, it skips that message.

## Customization

The queries are built dynamically from the dashboard UI. To add custom queries, edit the `getSelectedQueries()` function in `popup.js`.

Gmail search syntax reference: [support.google.com/mail/answer/7190](https://support.google.com/mail/answer/7190)

Examples:
- Specific sender: `from:noreply@example.com -is:starred -is:important`
- Specific label: `label:old-stuff -is:starred -is:important`
- Large emails: `larger:10M -is:starred -is:important`
- Read emails only: `is:read -is:starred -is:important`

## Tech Stack

- Vanilla JavaScript (no framework, no build step)
- Chrome Extension Manifest V3
- Gmail REST API via `chrome.identity`
- Zero dependencies

## FAQ

**Is my data safe?**
Yes — the extension talks directly to Gmail's API from your browser. No data is sent anywhere else.

**Can I undo?**
In Trash mode (the default): yes, go to Gmail → Trash. Everything stays for 30 days. In Permanent Delete mode: no, it's gone forever.

**The scan numbers say "~" — are they exact?**
Gmail's `resultSizeEstimate` is approximate for large result sets. The actual delete count will be exact.

**It stopped mid-way?**
Reopen the popup — it auto-detects incomplete jobs and offers to resume.

## License

MIT — do whatever you want with it.
