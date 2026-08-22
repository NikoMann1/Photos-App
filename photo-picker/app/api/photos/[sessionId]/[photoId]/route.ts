import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { photoPath, readSession } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves a single stored photo back to the browser. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; photoId: string }> },
): Promise<NextResponse | Response> {
  const { sessionId, photoId } = await params;

  try {
    const session = await readSession(sessionId);
    const meta = session?.photos.find((p) => p.id === photoId);
    if (!meta) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const bytes = await readFile(photoPath(sessionId, photoId));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": meta.type,
        "Content-Length": String(bytes.byteLength),
        // Ids are unique per upload, so the bytes never change under a URL.
        // Worth caching: the review grid and the share prefetch hit the same URL.
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="${encodeURIComponent(meta.name)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
