# photo-picker — milestone 1 skeleton

An end-to-end skeleton of the trip-photo picker: upload a batch of photos, get a
"best" subset back, and save them to the iPhone camera roll via the iOS share
sheet.

**The scoring is fake on purpose.** `lib/scoring.ts` returns a random ~10% of
what you uploaded. The whole point of this milestone is to prove the
save-to-Photos path on a real device before any ML work starts.

## Structure

```
photo-picker/
├── app/
│   ├── page.tsx                              # Upload screen
│   ├── review/page.tsx                       # "Best" photos + save button
│   └── api/
│       ├── upload/route.ts                   # Receives photos, runs scoring
│       └── photos/[sessionId]/[photoId]/     # Serves a stored photo back
├── lib/
│   ├── scoring.ts                            # PLACEHOLDER selection logic
│   └── storage.ts                            # Temp per-session file storage
├── components/
│   ├── PhotoUploader.tsx
│   ├── PhotoGrid.tsx
│   └── SaveToPhotosButton.tsx
└── scripts/lan-ip.mjs                        # Prints this Mac's wifi IP
```

Two files beyond the original sketch, both load-bearing: `lib/storage.ts` (the
upload route needs somewhere to put bytes) and the `api/photos/...` route (the
review grid and the share need to read those bytes back).

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

Uploads land in a per-session directory under the OS temp dir, with a
`meta.json` next to them. Nothing is kept in process memory, so the dev server
can hot-reload mid-session. Nothing is cleaned up either — the OS reaps it.

## Test on your iPhone

`navigator.share` **only exists in a secure context.** Over plain
`http://192.168.x.x:3000` Safari doesn't just fail the call — the API is
undefined, and you'll get the download-link fallback instead of the share sheet.
So testing the real save path needs HTTPS. Two ways:

### Option A — HTTPS on your local wifi (recommended)

Local, private, fast uploads. One-time cert trust on the phone.

```bash
npm run dev:https
```

That resolves your Mac's wifi IP and runs
`next dev --experimental-https -H <that IP>`. On first run Next downloads
`mkcert`, creates a local CA, and issues a cert (it may prompt for your
password). It prints something like `https://192.168.1.42:3000`.

The cert only covers the host passed to `-H`, which is why the script passes
the real IP rather than `0.0.0.0`.

Now trust that CA on the iPhone, one time:

1. `mkcert -CAROOT` on the Mac (or look at the path Next printed) — you want
   `rootCA.pem` in that directory.
2. AirDrop `rootCA.pem` to the iPhone and tap it.
3. **Settings → General → VPN & Device Management** → install the profile.
4. **Settings → General → About → Certificate Trust Settings** → toggle full
   trust on for the mkcert CA. *(This step is easy to miss; without it Safari
   still rejects the cert.)*

Then open `https://192.168.1.42:3000` in Safari. Mac and iPhone must be on the
same wifi, and the Mac's firewall must allow incoming connections for node.

Run `npm run lan-ip` any time to print the IP; it changes when you switch
networks, and the cert is per-IP, so a network change means a new cert.

### Option B — HTTPS tunnel (no cert trust needed)

Fastest to a working HTTPS URL; uploads go over the internet, and the URL is
public while it's up.

```bash
npm run dev                                   # terminal 1
cloudflared tunnel --url http://localhost:3000   # terminal 2
```

Open the `https://<random>.trycloudflare.com` URL on the phone. `ngrok http
3000` works the same way. Both hostname patterns are already allowlisted in
`next.config.ts`.

### Option C — plain http over wifi

```bash
npm run dev:lan     # binds 0.0.0.0, open http://<your-ip>:3000
```

Exercises upload, scoring, and the review grid, but **not** the share sheet —
no secure context, so you get download links, which on iOS save to Files, not
Photos.

### What you should see on the phone

1. **Choose photos** → Photo Library → pick 20–30 → Add. A progress bar counts
   up as batches upload.
2. `/review` shows ~10% of them in a grid (2 or 3 photos from a 25-photo batch).
3. **Save N photos to Photos** → the iOS share sheet opens → tap
   **Save N Images**. They appear in Recents in the Photos app.

If the button says "Preparing photos…" it's still fetching the image bytes; it
enables when they're in hand. That's deliberate — see below.

## Notes for the next milestone

- **Why the files are prefetched.** Safari requires `navigator.share()` to be
  called while the user gesture is still live. Awaiting `fetch` inside the click
  handler consumes that activation and the call fails with `NotAllowedError`.
  So `SaveToPhotosButton` fetches the `File` objects on mount and the click
  handler calls `share()` synchronously. Keep that shape when the real scoring
  lands — it's the single easiest thing to break here.
- **`allowedDevOrigins`.** Next's dev server 403s `/_next/*` requests from
  non-allowlisted hosts. Loading from the phone is exactly that: the HTML
  arrives, every JS chunk 403s, and the page never hydrates — the file picker
  just does nothing. `next.config.ts` allowlists private IP ranges, `*.local`,
  this machine's detected addresses, and the tunnel hostnames.
- **Uploads are batched** 5 files per POST, sequentially. A 30-photo batch off a
  phone is a few hundred MB in one request otherwise, and batching gives real
  progress. The server appends to `meta.json` without a lock, so those requests
  must not be parallelized.
- **Replacing the scorer**: `selectBestPhotos(photos)` in `lib/scoring.ts` is
  the only thing the API route calls. Per-photo scoring and selection are split
  so blur/duplicate/aesthetic work can slot into `scorePhoto` without touching
  the route or the UI. It currently runs on the metadata only — real scoring
  will need the pixels, so expect it to become async and read from
  `lib/storage.ts`.
- **Not done yet**: no session cleanup, no HEIC handling (Safari usually
  transcodes to JPEG on upload, but not always), no auth, no upload resume, and
  500-photo batches are untested — 20–30 is the tested range.

## Troubleshooting

- **Page loads but nothing responds to taps.** The app hasn't hydrated. Check
  the dev server console for a blocked cross-origin warning (add the host to
  `allowedDevOrigins`), and check that the HMR websocket connects — in dev, a
  websocket that can't reach the server blocks hydration. `npm run build && npm
  start` doesn't depend on HMR if you need to rule it out.
- **Download links instead of a share sheet.** Not a secure context. Confirm the
  URL is `https://` (Option A or B).
- **Safari won't load the HTTPS LAN URL.** The CA profile is installed but not
  trusted — Certificate Trust Settings, step 4 above.
- **"That upload session has expired."** The temp directory was reaped, or the
  server restarted onto a different temp root. Upload again.
