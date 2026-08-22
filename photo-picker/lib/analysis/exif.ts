/**
 * Minimal EXIF reader: capture time only.
 *
 * Burst detection needs to know whether two similar-looking frames were taken
 * seconds apart or hours apart. `File.lastModified` does not answer that — on
 * an iPhone it is usually when the file was exported, not when the shutter
 * fired — so read DateTimeOriginal out of the JPEG itself.
 *
 * Deliberately not a general EXIF library: it walks to one tag and stops.
 */

/** EXIF lives at the head of the file; no need to read a 4 MB photo to find it. */
const HEADER_BYTES = 256 * 1024;

const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;

export async function readCaptureTime(file: File): Promise<number | null> {
  try {
    const buffer = await file.slice(0, HEADER_BYTES).arrayBuffer();
    return parseCaptureTime(new DataView(buffer));
  } catch {
    return null;
  }
}

export function parseCaptureTime(view: DataView): number | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null; // markers are byte-aligned
    const marker = view.getUint8(offset + 1);
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;

    // APP1, the segment EXIF lives in.
    if (marker === 0xe1 && offset + 4 + 6 <= view.byteLength) {
      if (readAscii(view, offset + 4, 4) === "Exif") {
        return parseTiff(view, offset + 10);
      }
    }

    // Start of scan: image data from here, no more metadata.
    if (marker === 0xda) return null;
    offset += 2 + length;
  }

  return null;
}

function parseTiff(view: DataView, tiffStart: number): number | null {
  if (tiffStart + 8 > view.byteLength) return null;

  const endian = readAscii(view, tiffStart, 2);
  const littleEndian = endian === "II";
  if (!littleEndian && endian !== "MM") return null;
  if (view.getUint16(tiffStart + 2, littleEndian) !== 42) return null;

  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, littleEndian);

  // DateTimeOriginal lives in the Exif sub-IFD, which IFD0 points at.
  const exifIfdOffset = findTag(view, ifd0, tiffStart, littleEndian, TAG_EXIF_IFD_POINTER);
  if (exifIfdOffset == null) return null;

  const exifIfd = tiffStart + exifIfdOffset.numericValue;
  const dateTag = findTag(view, exifIfd, tiffStart, littleEndian, TAG_DATE_TIME_ORIGINAL);
  if (dateTag?.stringValue == null) return null;

  const offsetTag = findTag(view, exifIfd, tiffStart, littleEndian, TAG_OFFSET_TIME_ORIGINAL);
  return toEpochMs(dateTag.stringValue, offsetTag?.stringValue ?? null);
}

type TagValue = { numericValue: number; stringValue: string | null };

function findTag(
  view: DataView,
  ifdOffset: number,
  tiffStart: number,
  littleEndian: boolean,
  wantedTag: number,
): TagValue | null {
  if (ifdOffset + 2 > view.byteLength) return null;
  const count = view.getUint16(ifdOffset, littleEndian);

  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) return null;

    if (view.getUint16(entry, littleEndian) !== wantedTag) continue;

    const type = view.getUint16(entry + 2, littleEndian);
    const componentCount = view.getUint32(entry + 4, littleEndian);

    // ASCII string: inline if it fits in the 4-byte value slot, else a pointer.
    if (type === 2) {
      const length = Math.max(0, componentCount - 1); // drop the NUL
      const valueOffset =
        componentCount <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, littleEndian);
      if (valueOffset + length > view.byteLength) return null;
      return { numericValue: 0, stringValue: readAscii(view, valueOffset, length) };
    }

    return { numericValue: view.getUint32(entry + 8, littleEndian), stringValue: null };
  }

  return null;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * EXIF dates look like "2026:08:22 17:33:41" and carry no zone, so they are
 * local time at the camera. Only relative distance matters for burst
 * detection, so parsing them as UTC is harmless and consistent — but use the
 * real zone when OffsetTimeOriginal is present.
 */
export function toEpochMs(dateTime: string, utcOffset: string | null): number | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dateTime.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const zone = utcOffset && /^[+-]\d{2}:\d{2}$/.test(utcOffset.trim())
    ? utcOffset.trim()
    : "Z";

  const parsed = Date.parse(`${iso}${zone}`);
  return Number.isNaN(parsed) ? null : parsed;
}
