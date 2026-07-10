# Honest Archive Scan Client

A small desktop app (Electron) that watches a folder and automatically uploads
scanned invoices to Honest Archive. This is the "device agent" shops install.

## For users
Download the installer from the Honest Archive app (**Settings → Locations**, or
the setup wizard), run it, sign in with your Honest Archive account, pick the
folder your scanner saves to, and click **Start watching**. That's it.

> First-run note: the installer is currently **unsigned**, so Windows SmartScreen
> ("More info → Run anyway") or macOS Gatekeeper (right-click → Open) shows a
> one-time prompt. Signing removes this.

## Develop
```bash
npm install
npm start        # run the app locally
npm run dist     # build an installer for your current OS (output in dist/)
```

## Releasing installers
Push a tag and GitHub Actions builds Windows + Mac installers and publishes them
to a GitHub Release:
```bash
git tag v1.0.0 && git push origin v1.0.0
```
The install-wizard buttons point at `releases/latest/download/…`, so a new
release is picked up automatically.

## How it works
- No runtime npm dependencies — uses Electron's built-in `fetch`/`FormData`.
- Signs in via `/api/v1/auth/login`, then stores the shop's long-lived **ingest
  token** (from `/api/v1/onboarding/status`) in the OS user-data dir.
- Polls the watched folder every few seconds; uploads new files to
  `/api/v1/invoices/upload` with the ingest token; moves them to `processed/` or
  `failed/`.
