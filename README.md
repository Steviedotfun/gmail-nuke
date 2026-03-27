# 💣 Gmail Nuke

A Chrome extension that mass deletes old and junk Gmail emails while protecting your starred and important ones.

**No subscription. No backend. Everything runs in your browser.**

## What it does

- Deletes all email **before 2024** (or any date — edit the query)
- Deletes **Promotions, Social, Updates, Forums, Spam** from all time
- **Always protects** starred and Google-Important emails
- Dry Run mode to count emails before actually deleting
- Move to Trash (recoverable) or Permanent Delete
- Pause/resume/cancel any running job
- Survives Chrome restarts — picks up where it left off

## Setup (5 minutes)

### 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g., "gmail-nuke")
3. Enable the **Gmail API**: APIs & Services → Library → search "Gmail API" → Enable

### 2. Create OAuth credentials

1. APIs & Services → Credentials → **Create Credentials** → **OAuth client ID**
2. If prompted, configure the **OAuth consent screen**:
   - User type: **External**
   - App name: "Gmail Nuke"
   - Add your email as a **test user**
   - Add scopes: `gmail.readonly` and `gmail.modify`
3. Back to Credentials → Create OAuth client ID:
   - Application type: **Chrome Extension**
   - Item ID: you'll get this after loading the extension (see step 4)

### 3. Load the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select this folder
4. Copy the **extension ID** shown on the card

### 4. Finish OAuth setup

1. Go back to Google Cloud Console → Credentials
2. Edit your OAuth client → paste the **extension ID** into the Item ID field
3. Copy the **Client ID** (the long `...apps.googleusercontent.com` string)
4. Open `manifest.json` in this folder
5. Replace `YOUR_CLIENT_ID.apps.googleusercontent.com` with your actual Client ID
6. Go back to `chrome://extensions` and click the refresh icon on Gmail Nuke

### 5. Use it

1. Click the Gmail Nuke icon in your Chrome toolbar
2. Sign in when prompted
3. Check the categories you want to clean
4. Hit **Dry Run** first to see how many emails would be deleted
5. Hit **Start Deleting** when ready

## How it protects your email

Every query includes `-is:starred -is:important`, which tells Gmail to **never return** starred or important emails. On top of that, the extension double-checks each email's labels before deleting — if `STARRED` or `IMPORTANT` somehow appears, it skips that email.

## Customization

Edit the queries in `popup.js` (the `QUERIES` array at the top) to change what gets deleted. Gmail search syntax reference: [support.google.com/mail/answer/7190](https://support.google.com/mail/answer/7190)

Common tweaks:
- Change the date: `before:2023/01/01` or `before:2025/06/01`
- Only delete from a sender: `from:noreply@example.com -is:starred -is:important`
- Only delete with a label: `label:old-stuff -is:starred -is:important`

## FAQ

**Is my data safe?**
Yes. The extension runs entirely in your browser. No data is sent anywhere — it only talks to Gmail's API.

**Can I undo?**
If you used "Move to Trash" mode (the default), go to Gmail → Trash. Everything is there for 30 days. If you used "Permanent Delete", it's gone forever.

**It stopped mid-way?**
The extension saves progress after every batch. Reopen the popup — it will offer to resume.

**I hit a rate limit error.**
Gmail limits API calls. The extension handles this with backoff/retry, but if it errors, just wait a minute and hit "Try Again".

## License

MIT — do whatever you want with it.
