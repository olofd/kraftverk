import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import type { KraftverkApi, MediaType, NewMedia } from '@kraftverk/api-client';

/*
  Pictures, as this app makes and shows them (docs/PLAN-WORLD-MODEL.md
  §8.12). Made small where they are added — at most 2048 pixels a side —
  and re-encoded, which leaves behind what a photo says of itself: its EXIF,
  where it was taken among it. Shown from their bytes, asked of the family,
  so a picture shows the same with a server, with none, and on a phone.
*/

/** The most a picture is across, on its longer side. */
const LONGEST = 2048;

/**
 * A picture its owner picks, made small and re-encoded — or null when they
 * pick none. On the web, a file chosen, drawn on a canvas and written again
 * as WebP (JPEG where a browser cannot write WebP). On a phone: not yet, and
 * it says so.
 */
export async function pickPicture(): Promise<NewMedia | null> {
  if (Platform.OS !== 'web') throw new Error('On a phone, add a picture from the app in a browser for now');
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // Closed with nothing chosen: no change, and the window has its focus back.
    window.addEventListener('focus', () => setTimeout(() => (input.files?.length ? undefined : resolve(null)), 1000), { once: true });
    input.click();
  });
  if (!file) return null;
  const image = await createImageBitmap(file);
  const scale = Math.min(1, LONGEST / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
  image.close();
  const blob = await encoded(canvas, 'image/webp');
  const type: MediaType = blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const data = new Uint8Array(await (blob.type === type ? blob : await encoded(canvas, 'image/jpeg')).arrayBuffer());
  return { type, width, height, data };
}

const encoded = (canvas: HTMLCanvasElement, type: string): Promise<Blob> =>
  new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be made'))), type, 0.85));

/** Bytes as base 64: what a data URI wants, on a phone that may not have `btoa` for binary. */
function base64(bytes: Uint8Array): string {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b = 0, c = 0] = [bytes[index]!, bytes[index + 1], bytes[index + 2]];
    out += table[a >> 2]! + table[((a & 3) << 4) | (b >> 4)]! + (index + 1 < bytes.length ? table[((b & 15) << 2) | (c >> 6)]! : '=') + (index + 2 < bytes.length ? table[c & 63]! : '=');
  }
  return out;
}

/** A picture, by its id, as something an image can show: asked of the family once, and let go when no longer shown. */
export function usePicture(api: Pick<KraftverkApi, 'media'>, id: string | null): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    // Another picture: the one before is let go below, so it is not shown meanwhile.
    setUri(null);
    if (!id) return;
    let current = true;
    let made: string | null = null;
    void api.media
      .get(id)
      .then((picture) => {
        if (!current || !picture) return;
        made = Platform.OS === 'web' ? URL.createObjectURL(new Blob([picture.data as Uint8Array<ArrayBuffer>], { type: picture.type })) : `data:${picture.type};base64,${base64(picture.data)}`;
        setUri(made);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      if (made && Platform.OS === 'web') URL.revokeObjectURL(made);
    };
  }, [api, id]);
  return uri;
}
