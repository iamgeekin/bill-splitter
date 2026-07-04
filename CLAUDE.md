# CLAUDE.md

## Service worker cache versioning

`sw.js` caches the app shell under a versioned key: `const CACHE = "splittrip-vNN";`.

Whenever a PR changes `app.js`, `styles.css`, `index.html`, `manifest.webmanifest`, or `icon.svg`, bump the `vNN` number in `sw.js` by 1. Without this bump, users with the app already installed/cached (especially as a PWA) will keep serving stale assets indefinitely, since the old service worker only replaces its cache when it sees a new `CACHE` key.

This step is easy to forget since it's a one-line change unrelated to the PR's actual diff — always check it before opening a PR.
