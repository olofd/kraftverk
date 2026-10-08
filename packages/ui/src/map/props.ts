import { createContext, useContext } from 'react';

import type { LngLat, MapArea, MapMarker, MapTrail, MapZone } from '@kraftverk/map';

/*
  What a map is given, the same on every platform (MapView.web.tsx, and
  MapView.tsx on a phone) — and where the home serves its map from, which
  the app says once, around everything: a device's own screen draws a map
  without knowing whose server it is on.
*/

export type MapViewProps = {
  /** Where things are: a dot each, and a circle for how sure. */
  markers?: readonly MapMarker[];
  /** Where something has been. */
  trails?: readonly MapTrail[];
  /** Areas that mean something: home, a zone. */
  zones?: readonly MapZone[];
  /** A home's drawn rooms: outlined, named, filled while they are occupied. */
  areas?: readonly MapArea[];
  /** A floor's drawing, laid under its rooms: a picture's address and its corners — top-left, top-right, bottom-right, bottom-left. */
  drawing?: { url: string; corners: readonly [LngLat, LngLat, LngLat, LngLat] } | null;
  /** A shape being traced: its corners so far, joined as they are tapped. */
  tracing?: readonly LngLat[] | null;
  /** A tap on the map: where, on the Earth. A map that takes taps shows a cross for the pointer. */
  onPress?: (place: { latitude: number; longitude: number }) => void;
  /** Where to look when there is nothing else to fit: a place, and how many metres around it — a home before anything of it is drawn. */
  centre?: { latitude: number; longitude: number; metres: number } | null;
  /** The marker the map follows as it moves, until the person pans: then a button brings it back. */
  follow?: string | null;
  /** How tall, in points. */
  height?: number;
  /** What a screen reader says the map shows. */
  label: string;
};

/** The home's API (`https://home.example/api`), whose /map serves the tiles. Null where there is no server: no map. */
const MapApi = createContext<string | null>(null);

export const MapApiProvider = MapApi.Provider;

export const useMapApi = (): string | null => useContext(MapApi);
