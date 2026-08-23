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
│   │   ├── embedding.ts                      # Content embeddings (stage two)
│   │   ├── embed-worker.ts                   # Off-thread embedding
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

Analysis runs in the browser, in a worker per core, on photos downscaled to
512px.

Where the time goes, measured on 4032×3024 photos: **decode ~80 ms, canvas
scaling ~10 ms, all the metrics ~6 ms.** JPEG decode is over 80% of it and
there is no way around it in a browser — decoding at a target size via
`createImageBitmap` resize options measured *slower* in Chromium (152 vs 111
ms/photo), and canvas smoothing quality made no reliable difference. So the
levers are parallelism and overlap, not cleverness per photo: 40 full-size
photos take ~1.8 s here, or ~44 ms each. A phone is several times slower.

If a large batch still feels slow, the next lever is perceived rather than
actual speed: go to the review screen immediately and fill photos in as they
finish, instead of waiting behind a progress bar.

### The pause before any of this runs

On iPhone, the longest wait is not ours. Between tapping Add in the photo
picker and the picker closing, Safari transcodes every selected photo from HEIC
to JPEG, with no progress indication — so it looks like nothing is happening,
and it scales with how many photos were picked.

There is no way to prevent this from the page: setting `accept` does not stop
it, and Apple has documented no way to influence the picker's format choice
([Apple Developer Forums](https://developer.apple.com/forums/thread/743037)).
The only workarounds are on the device:

- In the picker, tap **Options** and set **Format** to **Current**, which hands
  over the original HEIC without converting it.
- Turn off **Settings → Photos → Optimize iPhone Storage**, or make sure the
  photos are already downloaded — otherwise iOS fetches originals from iCloud
  before it can hand them over.
- Pick fewer photos at a time.

If HEIC files do come through, Safari decodes them natively, but `lib/analysis/
exif.ts` only reads capture time from JPEG, so burst detection loses its
timestamps and falls back to the stricter hash-only rule. Photos that cannot be
decoded at all are still shown rather than silently dropped.

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

Selection then runs in four stages: **collapse near-duplicates** (so a burst of
ten spends one slot, not ten), **drop anything below an absolute quality bar**,
**rank what survives**, and take N by **diverse selection** — each pick
penalised by how much it resembles what is already picked.

That last stage exists because of a real result. On a 100-photo batch from a
phone, every surviving photo scored between **0.92 and 0.96**, nothing was
rejected as blurry, and only 3 duplicates were found. Modern phone photos are
essentially all technically fine, so the quality bar does nothing and ranking
by score alone returns an arbitrary ten — several of them the same subject.
Diversity spreads the picks by colour, layout and time, which is why
`DIVERSITY_WEIGHT` is deliberately larger than that 0.04 score spread: when
quality cannot separate two photos, how different they are should decide.

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

## Stage two: what the photo is of

The measurements above cannot tell two shots of the same room apart from two
shots of different rooms — they compare colour and layout, so a hue-shifted
copy of one photo reads as a different subject. So a second stage runs
MobileCLIP S0's vision tower to produce a 512-dimension embedding of what each
photo actually shows.

Measured with this model on real photos:

| mirrored copy | hue-shifted | same scene, reframed | unrelated | flat colour |
| --- | --- | --- | --- | --- |
| 0.991 | 0.878 | 0.857 | 0.190 | 0.216 |

Diversity and duplicate detection use this when it is available and fall back
to the cheap signals when it is not.

**It only runs on a shortlist.** Embedding costs ~300 ms a photo against stage
one's ~50 ms, so it runs on the deduplicated, quality-passing contenders — a
few times the number of slots — rather than the whole batch.

### Three findings worth keeping

1. **The quantized model is unusable.** `vision_model_quantized.onnx` is 11 MB
   against fp16's 21 MB, and its output is noise: a mirrored copy of a photo
   scored 0.349 against it while a flat blue rectangle scored 0.368. fp16
   matches fp32 to three decimals. Do not "optimise" the download by switching.
2. **Zero-shot aesthetics do not work.** Scoring photos against "a beautiful
   photograph" versus "a boring snapshot" ranked floor grating above a harbour
   view, and called the two most photographic images in the batch the most
   boring. It was tested and dropped.
3. **Threads do not help.** Four WASM threads measured 299 ms against 298 ms
   for one. Parallelism comes from running several photos at once instead.

### Weights and runtime

Both are fetched from a CDN and cached by the browser — together ~24 MB
gzipped on first visit, nothing after. They are not committed because ~36 MB of
binaries do not belong in a git repository. To self-host, serve them and set
`NEXT_PUBLIC_EMBED_MODEL_URL` and `NEXT_PUBLIC_ORT_WASM_URL`.

If either fetch fails the app still works: photos without embeddings fall back
to colour, layout and time, which is covered by a test.

## Storage

**Original photos are never written to storage.** A picked file is already held
by the browser outside this origin's quota; copying it into IndexedDB is what
consumes the budget, and a 500-photo batch off a phone is well over a gigabyte
— far past what iOS grants a website. Exceeding that quota does not surface as
an error the user can see: the photo picker simply stops closing when Add is
tapped, because the newly picked files cannot be staged.

So what persists is a ~40 KB JPEG preview per photo, re-encoded from the canvas
the analysis already drew (one extra encode, no second decode), plus scores and
embeddings. Measured: a 180 MB batch persists as **0.07 MB**. Only the newest
batch is kept, and within it only photos that can still appear — the pool
steering re-chooses from, whatever is shown, and anything that could not be
scored.

Originals stay in memory for the session. That survives navigating from the
upload screen to the review screen, but not a reload — the deliberate trade.
After a reload the grid still renders from previews and the review screen says
that saving needs the photos picked again, because handing a downscaled preview
to the camera roll would be worse than saying so.

If a save still fails for space, storage is cleared and the save retried once.

## Steering

Tapping **♥** keeps a photo and makes similar ones cheaper to include; **✕**
drops it and pushes its whole subject down. Choices persist with the batch and
survive a reload, and **Reset choices** clears them.

This is the only signal in the system that comes from the person looking at the
photos rather than from a guess about taste — which matters, because the guess
was tried and failed (see the aesthetic prompts above).

A like is deliberately **not** a score bonus. A bonus fights the novelty penalty
photo-for-photo and simply beats it: liking one photo then returns five
near-copies of it, undoing diverse selection. Making the bonus smaller inverts
the intent instead, ranking unrelated subjects above the liked one because they
are penalised least. So a like *discounts the novelty penalty* rather than
opposing it. Coverage still decides the early picks; photos resembling
something liked become cheaper to repeat, so surplus slots go where the user
pointed.

`LIKE_RELIEF` is load-bearing: above roughly 0.72, repeating the liked subject
becomes cheaper than covering a new one and the results collapse into
near-copies again. It sits at 0.5 to leave headroom under that cliff. A
rejection, being unambiguous, is a straight penalty.

Steering degrades rather than misbehaves without embeddings: the controls only
appear when the model ran, and pinning and dropping still work if it did not.

## Known limit: batch size

**Around 175 photos is the practical cap.** 250 was tried on an iPhone and
nothing happened — the batch never got as far as analysis. Not yet diagnosed,
and deliberately left alone for now.

What is already ruled out: storage. Originals are no longer persisted at all,
so a 250-photo batch writes roughly 10 MB of previews, not gigabytes (see
[Storage](#storage)). The remaining candidates, in rough order of suspicion:

1. **The iOS import step.** Safari transcodes every selected photo from HEIC to
   JPEG before handing any of them over, with no progress indication, and it
   scales with the count — 250 photos is a long silence, and it may simply give
   up. This failure happens before any of this app's code runs.
2. **Memory.** Two embedding workers each hold a copy of the model, and stage
   one decodes photos in parallel across a worker per core. A tab that is
   already near iOS's ceiling has no room left for the picker to stage files.
3. **Something in the pipeline that is quadratic in batch size.** Duplicate
   grouping compares each photo against every group, which is fine at 50 and
   worth measuring at 250.

Distinguishing these needs a device. The obvious first probe is whether 250
photos behave any differently with the picker's **Format** set to **Current**,
which skips the transcode entirely.

## Preferences across batches

Steering used to start from nothing every upload. Since the batch cap makes a
trip several uploads, the app forgot what it had just been taught each time.
What the user keeps and drops now persists in its own IndexedDB store, which
survives the batch cleanup that deliberately discards everything else.

Three rules shape it, each with a test:

1. **A remembered dislike demotes; it never excludes.** Dropping one photo of a
   bathroom must not permanently hide the one with the plaque on the wall. Only
   an explicit ✕ on a photo in the current batch removes anything outright.
2. **Tastes are exemplars, not an average.** Liking engine rooms *and* harbour
   views averages to a direction meaning neither, so affinity is the best match
   against any remembered photo rather than the mean of them.
3. **A tap beats a memory.** Remembered relief and current-batch relief do not
   stack; the larger applies, so an old batch can never outweigh what the user
   is saying about this one.

Preferences are **visible and one tap from gone** — the review screen says how
many kept and dropped photos are informing the batch, with a Forget control.
Silently reshaping results across sessions is the same failure as a wrong
duplicate merge, and worse for persisting.

Records are kept per batch (10 batches, 20 photos each) so undoing a tap undoes
what was learned from it rather than leaving it behind.

## Still not solved: judgement

None of this can tell a striking composition from a well-exposed photo of
nothing. A boring-but-sharp frame outranks an interesting one with slight
motion blur.

Stage two closed half of this gap: the app now knows when two photos show the
same thing. What it still has no opinion about is whether that thing was worth
photographing.

Concept prompts are the obvious next step and theyhalf work. Tested against real
photos from a museum visit, `a photo of a toilet or bathroom` and `a close-up
photo of machinery` both identified their subject as the clear top match, and
`a photo of beds and bunks` found all three bunk photos. But `a photo of
people` found only the most obvious one, ranking a photo of floor grating above
two photos that clearly contain people — at least at the crop and resolution
tested. Worth revisiting on full-resolution photos before building ranking on
top of it.

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
