import { NextResponse } from "next/server";
import { appendPhotos, finalizeSession, readSession } from "@/lib/storage";

// Photos are written to disk, so this must run on the Node.js runtime, and it
// must never be statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type UploadResponse = {
  sessionId: string;
  uploaded: number;
  total: number;
  finalized: boolean;
};

export type SessionResponse = {
  sessionId: string;
  total: number;
  finalized: boolean;
  photos: Array<{
    id: string;
    name: string;
    type: string;
    size: number;
    url: string;
  }>;
};

/**
 * Receives one batch of photos.
 *
 * The client uploads in small sequential batches (see PhotoUploader) rather
 * than one giant multipart request: it keeps a 30-photo upload from an iPhone
 * on wifi from being a single multi-hundred-megabyte POST, and it gives us
 * real progress. The last batch is sent with `finalize=1`.
 *
 * Scoring does not happen here — it needs decoded pixels, and those live in
 * the browser. See `lib/analysis/`.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const sessionId = String(form.get("sessionId") ?? "");
  const finalize = form.get("finalize") === "1";
  const files = form.getAll("photos").filter((f): f is File => f instanceof File);

  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }
  if (files.length === 0 && !finalize) {
    return NextResponse.json({ error: "No photos in request" }, { status: 400 });
  }

  try {
    let session = files.length > 0 ? await appendPhotos(sessionId, files) : await readSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: "Unknown session" }, { status: 404 });
    }

    if (finalize) {
      session = await finalizeSession(sessionId);
    }

    const body: UploadResponse = {
      sessionId,
      uploaded: files.length,
      total: session.photos.length,
      finalized: finalize,
    };
    return NextResponse.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Returns the selected photos for a session, with URLs the browser can load. */
export async function GET(request: Request): Promise<NextResponse> {
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const session = await readSession(sessionId).catch(() => null);
  if (!session) {
    return NextResponse.json({ error: "Unknown session" }, { status: 404 });
  }
  const body: SessionResponse = {
    sessionId,
    total: session.photos.length,
    finalized: session.finalized,
    photos: session.photos.map((photo) => ({
      ...photo,
      url: `/api/photos/${sessionId}/${photo.id}`,
    })),
  };
  return NextResponse.json(body);
}
