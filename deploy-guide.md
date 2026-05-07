# Deployment Guide — Reading Practice Tracker

Deploy once. After that, just open your domain to use the tracker.

---

## What you need
- A Cloudflare account (free) — cloudflare.com
- Your domain already on Cloudflare (for DNS)
- Your Notion integration token (`secret_xxx...`) from the setup you already did
- Your Notion database ID (see Step 0 below)

---

## Step 0 — Get your Notion Database ID

1. In Notion, open your **Reading Practice Tracker** page
2. Click into the **Sessions** database so it fills the page (click the expand arrows `⤢` or the database title)
3. Look at the browser URL — it looks like:
   `https://www.notion.so/Sessions-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX?v=...`
4. The 32-character hex string after the last `/` and before the `?` is your **Database ID**
   e.g. `3418df473817812d8f82ce012880d03e`

---

## Step 1 — Deploy the Cloudflare Worker

The Worker is the secure backend that talks to Notion.

1. Go to **dash.cloudflare.com** → **Workers & Pages** → **Create**
2. Choose **Create Worker** → give it a name like `reading-tracker-api`
3. Click **Deploy** (deploys a placeholder)
4. Click **Edit code** — paste the entire contents of `worker/worker.js`
5. Click **Deploy**

### Add secrets to the Worker
1. In your Worker page, go to **Settings** → **Variables and Secrets**
2. Add two **Secret** variables (not plain text — click the "Secret" toggle):
   - `NOTION_TOKEN` → your `secret_xxx...` token
   - `NOTION_DATABASE_ID` → the 32-char ID from Step 0
3. Click **Save and deploy**

Your Worker URL will be something like:
`https://reading-tracker-api.YOUR-SUBDOMAIN.workers.dev`

---

## Step 2 — Update the Worker URL in the HTML

Open `index.html` (in the repo root) and find line near the top of the `<script>` block:

```js
const WORKER_URL = "https://YOUR_WORKER.workers.dev";
```

Replace it with your actual Worker URL from Step 1, e.g.:

```js
const WORKER_URL = "https://reading-tracker-api.abc123.workers.dev";
```

Save the file.

---

## Step 3 — Deploy the HTML to Cloudflare Pages

1. Push the repo to GitHub. The deployable file is `index.html` in the repo root.
2. In Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages**
3. Connect your GitHub account → select the repo
4. Build settings: leave all blank (it's a static HTML file, no build needed). Build output directory should be the repo root (`/`).
5. Click **Save and Deploy**

Cloudflare gives you a URL like `https://reading-tracker.pages.dev`

### Connect your custom domain (optional)
1. In your Pages project → **Custom domains** → **Set up a custom domain**
2. Enter e.g. `tracker.yourdomain.com`
3. Cloudflare auto-creates the DNS record — done

---

## Step 4 — Protect with Cloudflare Access (authentication)

This ensures only you can open the tracker.

1. Go to **dash.cloudflare.com** → **Zero Trust** (left sidebar)
2. **Access** → **Applications** → **Add an application**
3. Choose **Self-hosted**
4. **Application name**: `Reading Tracker`
5. **Application domain**: your Pages URL or custom domain (e.g. `tracker.yourdomain.com`)
6. Click **Next**
7. **Policy name**: `Owner only`
8. **Include** → **Emails** → add your email address
9. Click **Next** → **Add application**

Now when you visit the tracker, Cloudflare sends a one-time code to your email to log in. After that you stay logged in for the configured session duration.

---

## Testing the full flow

1. Visit your tracker URL
2. Log in via email OTP
3. Fill in a session and click **Save to Notion**
4. Open Notion — confirm the session appears with formatted feedback
5. Click **Review** tab — confirm past sessions load and expand correctly

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Error: Invalid token" | Check `NOTION_TOKEN` secret in Worker settings |
| "The integration cannot see any pages" | Re-run `setup-notion.js` or check the integration is connected to your page |
| CORS error in browser console | Check the Worker URL in `index.html` is correct and the Worker is deployed |
| Access loop / can't log in | Check your email matches the one in the Access policy |
