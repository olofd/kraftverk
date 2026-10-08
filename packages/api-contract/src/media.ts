/*
  Pictures (docs/PLAN-WORLD-MODEL.md §8.12): of homes and devices, kept by
  their content. Made small and stripped of their metadata where they are
  added — the app re-encodes them — and checked here for what they say they
  are.
*/

export type MediaType = 'image/webp' | 'image/jpeg' | 'image/png';

/** A picture kept: its id is the SHA-256 of its bytes. */
export type MediaView = { id: string; type: MediaType; bytes: number; width: number; height: number };

/** A picture to keep: its bytes, what they are, and how big it is, as the app that made it knows. */
export type NewMedia = { type: MediaType; width: number; height: number; data: Uint8Array };

/** A picture's bytes, as kept. */
export type MediaData = { type: MediaType; data: Uint8Array };
