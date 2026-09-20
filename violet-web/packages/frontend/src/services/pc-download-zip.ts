import { Zip, ZipPassThrough } from 'fflate';

// Bound memory use and stay below ZIP32 limits. Images are already compressed.
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

function imageExtension(data: Uint8Array): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end));
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data[0] === 0x89 && ascii(1, 8) === 'PNG\r\n\x1a\n') return 'png';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'avif';
  throw new Error('invalidImage');
}

export async function createGalleryZip(
  urls: string[],
  loadImage: (url: string, signal: AbortSignal) => Promise<Uint8Array>,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
): Promise<Blob> {
  signal.throwIfAborted();
  if (!urls.length) throw new Error('noImages');
  const chunks: BlobPart[] = [];
  let size = 0;
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) { zipError = error; return; }
    size += chunk.length;
    if (size > MAX_ZIP_BYTES) { zipError = new Error('tooLarge'); return; }
    chunks.push(new Uint8Array(chunk));
  });
  try {
    onProgress(0, urls.length);
    for (let index = 0; index < urls.length; index++) {
      signal.throwIfAborted();
      const data = await loadImage(urls[index], signal);
      signal.throwIfAborted();
      const extension = imageExtension(data);
      if (size + data.length > MAX_ZIP_BYTES) throw new Error('tooLarge');
      const entry = new ZipPassThrough(`${String(index + 1).padStart(6, '0')}.${extension}`);
      zip.add(entry);
      entry.push(data, true);
      if (zipError) throw zipError;
      onProgress(index + 1, urls.length);
    }
    signal.throwIfAborted();
    zip.end();
    if (zipError) throw zipError;
    return new Blob(chunks, { type: 'application/zip' });
  } finally {
    zip.terminate();
  }
}
