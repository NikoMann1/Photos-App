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
│       ├── upload/route.ts                   # Receives photos, stores + scores
│       └── photos/[sessionId]/[photoId]/     # Serves a stored photo back
├── lib/
│   ├── scoring.ts                            # PLACEHOLDER selection logic
│   ├── browser-session.ts                    # Photos held in the browser
│   └── storage.ts                            # Temp server-side file storage
├── components/
│   ├── PhotoUploader.tsx
│   ├── PhotoGrid.tsx
│   └── SaveToPhotosButton.tsx
└── scripts/lan-ip.mjs                        # Prints this Mac's wifi IP
```

## Where the photos live

**The photos stay in the browser.** The file picker's `File` objects go into
IndexedDB, the review grid renders them from object URLs, and the share hands
those very same `File` objects to `navigator.share`. Nothing has to reach a
server for save-to-Photos to work.

That's not just convenient — it's the more reliable design for this milestone.
Safari requires `navigator.share()` to be called while the user gesture is still
live, so any `await` before it (like fetching image bytes back from a server)
risks a `NotAllowedError`. With the files already in hand the click handler is
fully synchronous, which is the safest shape available on iOS. It also means the
app deploys anywhere, including serverless hosts with no persistent filesystem.

The server upload path still exists and still works — `POST /api/upload` stores
photos in a per-session temp directory with a `meta.json` alongside, and
`/api/photos/...` serves them back. It's off by default because it needs a
long-running server with a real disk. Turn it on to exercise it locally:

```bash
NEXT_PUBLIC_UPLOAD_TO_SERVER=1 npm run dev
```

Milestone 2 decides whether real scoring runs on the server (which needs the
pixels up there) or in the browser via WASM. This keeps both doors open.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

## Deploy it (test from a phone, no computer needed)

The app is a standard Next.js project in a subdirectory, so any Next host works.
On Vercel, the one setting that matters is **Root Directory → `photo-picker`**;
the framework preset and build commands auto-detect. Any HTTPS deployment gives
you a secure context, which is all the share sheet needs.

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

- **Keep the share call synchronous.** Safari requires `navigator.share()` to
  be called while the user gesture is still live; an `await` before it consumes
  that activation and the call fails with `NotAllowedError`. `SaveToPhotosButton`
  has zero async before `share()`. If real scoring ever moves the photos back
  behind a server round trip, prefetch the `File` objects on mount rather than
  fetching them in the click handler — this is the single easiest thing here to
  break.
- **`allowedDevOrigins`.** Next's dev server 403s `/_next/*` requests from
  non-allowlisted hosts. Loading from the phone is exactly that: the HTML
  arrives, every JS chunk 403s, and the page never hydrates — the file picker
  just does nothing. `next.config.ts` allowlists private IP ranges, `*.local`,
  this machine's detected addresses, and the tunnel hostnames.
- **Server uploads are batched** 5 files per POST, sequentially (when the flag
  above is on). A 30-photo batch off a phone is a few hundred MB in one request
  otherwise, and batching gives real progress. The server appends to `meta.json`
  without a lock, so those requests must not be parallelized.
- **Replacing the scorer**: `selectBestPhotos(photos)` in `lib/scoring.ts` is
  the only thing the API route calls. Per-photo scoring and selection are split
  so blur/duplicate/aesthetic work can slot into `scorePhoto` without touching
  the route or the UI. It currently runs on the metadata only — real scoring
  will need the pixels, so expect it to become async and read from
  `lib/storage.ts`.
- **Not done yet**: no HEIC handling (Safari usually transcodes to JPEG when
  picking, but not always), no auth, and 500-photo batches are untested — 20–30
  is the tested range. Browser storage prunes sessions older than an hour;
  server-side temp directories are left for the OS to reap.

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
- **"That batch isn't in this browser's storage."** The photos live in
  IndexedDB, so a different browser, a private window, or cleared site data all
  lose them. Upload again in the same browser.
