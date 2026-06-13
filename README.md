# SplitTrip — Trip Bill Splitter

A single-page web app for splitting bills between friends on a trip. Runs **entirely in the browser** — no backend, no app store, no Apple developer account. Data is stored locally on your device.

## Features
- **Manual entry** — quick "split equally" between any subset of people.
- **Photo entry (OCR)** — snap a receipt; line items are read with [Tesseract.js](https://tesseract.js.org/) (runs in-browser) and you assign each item to specific people.
- **Pick who's involved** — choose the payer and exactly who shares each bill or item.
- **History table** — every bill in a tidy, filterable table with a paid/unpaid toggle.
- **Settle up** — looks at all *unpaid* bills and tells you the minimum set of payments: who pays whom and how much.
- **Tax & tip** — for itemized bills, allocated proportionally to each person's items.
- **Backup** — export/import your data as a JSON file.

## Put it on your iPhone (no developer account, no local server)

You just need to host these static files once on any free static host, then open the link in Safari.

### Option A — Netlify Drop (easiest, ~1 min)
1. Go to **https://app.netlify.com/drop** on a computer.
2. Drag the whole `bill-splitter` folder onto the page.
3. Netlify gives you an HTTPS link like `https://something.netlify.app`.
4. Open that link in **Safari on your iPhone**.

### Option B — GitHub Pages
1. Create a repo, upload these files.
2. Settings → Pages → deploy from `main` / root.
3. Open the published `https://<user>.github.io/<repo>/` link in Safari.

### Option C — Cloudflare Pages
Create a project, upload the folder, open the `*.pages.dev` link in Safari.

### Then: Add to Home Screen
In Safari, tap the **Share** button → **Add to Home Screen**. It now launches full-screen like a native app, works offline (after first load), and keeps your data between sessions.

> **OCR needs internet on first use.** The OCR engine (~2–4 MB) is downloaded from a CDN the first time you scan a receipt, then cached. Manual entry, history, and settle-up work fully offline.

## Notes & limits
- Data lives in this browser's `localStorage` on your phone. **Use Export regularly** so you don't lose data if you clear Safari website data. Move to a new phone by Export → Import.
- iOS Safari's camera "Take Photo" appears when you tap **Scan receipt**; you can also choose an existing photo.
- Everything is private — nothing is uploaded anywhere.

## Run/preview locally (optional)
Any static server works, e.g. from this folder:
```
python -m http.server 8000
```
then open `http://localhost:8000`. (A server isn't required to *use* the app — only the service-worker offline cache needs `https`/`localhost`.)
