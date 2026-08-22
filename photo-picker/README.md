# photo-picker

Pick a batch of trip photos, get the best ones back, save them to the iPhone
camera roll via the iOS share sheet. Everything runs on the device.

- **Milestone 1** (done): end-to-end skeleton, proving the save-to-Photos path
  on a real iPhone.
- **Milestone 2** (this): real scoring — focus, exposure, tonal range, colour,
  and near-duplicate collapsing. See [Scoring](#scoring).

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
│   ├── scoring.ts                            # Scoring, dedup, selection
│   ├── analysis/
│   │   ├── metrics.ts                        # Pure pixel measurements
│   │   ├── decode.ts                         # Photo → downscaled pixels
│   │   ├── exif.ts                           # Capture time, for bursts
│   │   ├── worker.ts                         # Off-main-thread analysis
│   │   └── index.ts                          # Worker pool + fallback
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

## Scoring

Analysis runs in the browser, in a pool of up to four workers, on photos
downscaled to 512px. A 19-photo batch measures in about 300 ms on a laptop.

Everything measured is *technical* quality — `lib/analysis/metrics.ts` is pure
functions over raw pixels, so it is unit-testable without a browser:

| Signal | What it catches |
| --- | --- |
| `focus` | Blur and missed focus (variance of the Laplacian) |
| `noiseRatio` | Grain masquerading as detail |
| exposure | Blown highlights, crushed shadows, too dark or bright |
| tone | Flat, hazy frames with no tonal range |
| colour | Vivid versus washed out, weighted lightly |
| `hash` + `colorSignature` | Near-duplicates and bursts |

Selection then runs in three stages: **collapse near-duplicates** (so a burst
of ten spends one slot, not ten), **drop anything below an absolute quality
bar**, then **rank what survives** and take the top N.

### Three things that bit during calibration

Each of these had a test written against it, so they cannot come back quietly:

1. **Sharpness moves with exposure.** A raw Laplacian scales with pixel
   magnitude, so brightening a photo made it measure *twice as sharp* as the
   original it came from. Normalising by contrast² fixes it — but then a
   near-flat frame divides by almost nothing and a blurred photo measured
   sharper than a good one. Both measures are now combined by taking the worse.

2. **Grain reads as detail.** Pure noise scored 0.97 and ranked first in the
   batch. Comparing high-frequency energy before and after halving the
   resolution separates the two: real detail survives downsampling, grain
   averages away (0.5–0.8 for real photos, 2.9 grainy, 4.0 pure noise).

3. **An 8×8 hash merges unrelated photos.** Anything with one dominant
   gradient — a sky, a sunset, a wall — makes every "brighter than the pixel to
   its right" comparison answer the same way, so the hash degenerates towards
   all-ones and unrelated photos land a bit or two apart. In one test batch, 17
   of 22 photos collapsed into 2 groups. Now: a 256-bit hash, a
   brightness-invariant colour signature, an explicit degenerate-hash check,
   and a timestamp guard for the looser threshold. Merging errs towards keeping
   photos apart — an uncollapsed burst costs a slot, a wrong merge silently
   destroys a photo the user never sees.

### Tuning

Thresholds are named constants at the top of `lib/scoring.ts`, each with the
measurement that produced it. They were calibrated against a small corpus, so
expect to adjust them against a real trip batch — `SHARPNESS_FLOOR` in
particular decides what counts as "too soft to keep".

Tap **Show scores** on the review screen to see each photo's score and why the
bar rejected it.

```bash
npm test        # 18 tests, no fixtures or image libraries needed
```

## Still not solved: aesthetic quality

None of this can tell a striking composition from a well-exposed photo of
nothing. A boring-but-sharp frame outranks an interesting one with slight
motion blur.

That is also why the count is still governed by a ratio (`SELECTION_RATIO`,
floored at 5 and capped at 50) rather than falling out of the quality bar: on
technical merit alone most of a decent batch passes, so "keep everything above
the bar" would hand back nearly everything. Selecting purely by an absolute bar
becomes right once the score captures interestingness — a small on-device
aesthetic model (NIMA-style, a few MB via ONNX Runtime Web or TFJS) is the
natural next step, at which point the floor and cap become guardrails rather
than the deciding factor.

## Other notes

- **Keep the share call synchronous.** Safari requires `navigator.share()` to
  be called while the user gesture is still live; an `await` before it consumes
  that activation and the call fails with `NotAllowedError`.
  `SaveToPhotosButton` has zero async before `share()`.
- **`allowedDevOrigins`.** Next's dev server 403s `/_next/*` requests from
  non-allowlisted hosts. Loading from a phone is exactly that: the HTML
  arrives, every JS chunk 403s, and the page never hydrates — the file picker
  just does nothing. `next.config.ts` allowlists private IP ranges, `*.local`,
  this machine's detected addresses, and tunnel hostnames.
- **Server uploads are batched** 5 files per POST, sequentially, when
  `NEXT_PUBLIC_UPLOAD_TO_SERVER=1`. The server appends to `meta.json` without a
  lock, so those requests must not be parallelized.
- **Not done yet**: no HEIC handling (Safari usually transcodes to JPEG when
  picking, but not always), no auth, and 500-photo batches are untested — 20–30
  is the tested range. Browser storage prunes sessions older than an hour.

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
