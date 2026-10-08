import { useEffect, useRef, useState } from 'react';
import { Text, useTheme, XStack, YStack } from 'tamagui';
import type * as MapLibre from 'maplibre-gl';

import { accuracyGeoJSON, areasGeoJSON, boundsOf, MAP_CREDIT, mapStyle, markersGeoJSON, trailsGeoJSON, zonesGeoJSON, type LngLat } from '@kraftverk/map';

import { Icon } from '../Icon.tsx';
import { useMapApi, type MapViewProps } from './props.ts';

/*
  A map, on the web: MapLibre GL, loaded when the first map is shown — from
  this app's own origin (/map, copied beside the app at its build), never
  bundled: a megabyte nobody needs until a map is open — drawing the home's
  own tiles (@kraftverk/map's style). Markers, how sure each is, trails and
  zones are GeoJSON sources, set again as they change. It follows a marker
  until the person pans, and a button brings it back. Its buttons are 40 px,
  and its credit is words, not MapLibre's small button.
*/

type Lib = typeof MapLibre;

let loading: Promise<Lib> | null = null;

/** The library, once: a module of this app's own, which hands it over on the window. */
function maplibre(): Promise<Lib> {
  loading ??= new Promise<Lib>((resolve, reject) => {
    const held = (window as { __kraftverkMapLibre?: Lib }).__kraftverkMapLibre;
    if (held) return resolve(held);
    window.addEventListener('kraftverk-maplibre', () => resolve((window as { __kraftverkMapLibre?: Lib }).__kraftverkMapLibre!), { once: true });
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = '/map/maplibre-gl.css';
    document.head.appendChild(style);
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/map/load.mjs';
    script.onerror = () => {
      loading = null;
      reject(new Error('The map could not be loaded'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

const SOURCES = ['kv-zones', 'kv-areas', 'kv-tracing', 'kv-accuracy', 'kv-trails', 'kv-markers'] as const;

/** A traced shape so far: its line, and a dot at each corner. */
const tracingGeoJSON = (corners: readonly LngLat[]) => ({
  type: 'FeatureCollection',
  features: [
    ...(corners.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: corners } }] : []),
    ...corners.map((corner) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: corner } })),
  ],
});

/** How close a map looks when it fits what it shows: a street for markers, a room for a home's drawing. */
const FIT_ZOOM = 15;
const FIT_ZOOM_INDOORS = 20;

/** The box of so many metres around a place: west, south, east, north. */
const around = (centre: { latitude: number; longitude: number; metres: number }): [number, number, number, number] => {
  const dLat = centre.metres / 111_320;
  const dLon = dLat / Math.max(0.01, Math.cos((centre.latitude * Math.PI) / 180));
  return [centre.longitude - dLon, centre.latitude - dLat, centre.longitude + dLon, centre.latitude + dLat];
};

export function MapView({ markers = [], trails = [], zones = [], areas = [], drawing = null, tracing = null, onPress, centre = null, follow = null, height = 280, label }: MapViewProps) {
  const api = useMapApi();
  const theme = useTheme();
  const accent = theme.accent?.val ?? '#4ade80';
  const muted = theme.muted?.val ?? '#888';
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibre.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Following until the person pans; a button brings it back.
  const [following, setFollowing] = useState(true);
  const fitted = useRef(false);
  // The tap, as it is now: the map is made once.
  const pressed = useRef(onPress);
  pressed.current = onPress;

  // The map itself: made once, when the library is here.
  useEffect(() => {
    if (!api || !holder.current) return;
    let gone = false;
    maplibre()
      .then((lib) => {
        if (gone || !holder.current) return;
        const made = new lib.Map({
          container: holder.current,
          style: mapStyle({ api, theme: 'dark' }) as unknown as MapLibre.StyleSpecification,
          attributionControl: false,
          // The session's cookie, where the app and its server are two origins (development).
          transformRequest: (url) => ({ url, credentials: 'include' }),
          dragRotate: false,
          pitchWithRotate: false,
        });
        made.touchZoomRotate.disableRotation();
        // Once its style is there, not its first tiles: what it shows, and where it looks, do not wait on a slow tile.
        made.once('style.load', () => {
          for (const id of SOURCES) made.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          made.addLayer({ id: 'kv-zones-fill', type: 'fill', source: 'kv-zones', paint: { 'fill-color': accent, 'fill-opacity': 0.08 } });
          made.addLayer({ id: 'kv-zones-line', type: 'line', source: 'kv-zones', paint: { 'line-color': accent, 'line-opacity': 0.5, 'line-width': 1.5, 'line-dasharray': [2, 2] } });
          // A home's rooms: outlined, filled while someone is in them, named where they are.
          made.addLayer({ id: 'kv-areas-fill', type: 'fill', source: 'kv-areas', paint: { 'fill-color': accent, 'fill-opacity': ['case', ['get', 'filled'], 0.4, 0.04] } });
          made.addLayer({ id: 'kv-areas-line', type: 'line', source: 'kv-areas', paint: { 'line-color': accent, 'line-opacity': 0.85, 'line-width': 2 } });
          made.addLayer({
            id: 'kv-areas-label',
            type: 'symbol',
            source: 'kv-areas',
            layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 13 },
            paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.7)', 'text-halo-width': 1.5 },
          });
          made.addLayer({ id: 'kv-tracing-line', type: 'line', source: 'kv-tracing', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1] } });
          made.addLayer({ id: 'kv-tracing-corners', type: 'circle', source: 'kv-tracing', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': accent, 'circle-stroke-width': 2 } });
          made.addLayer({ id: 'kv-accuracy-fill', type: 'fill', source: 'kv-accuracy', paint: { 'fill-color': accent, 'fill-opacity': 0.15 } });
          made.addLayer({ id: 'kv-accuracy-line', type: 'line', source: 'kv-accuracy', paint: { 'line-color': accent, 'line-opacity': 0.5, 'line-width': 1 } });
          made.addLayer({ id: 'kv-trails', type: 'line', source: 'kv-trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': accent, 'line-opacity': 0.75, 'line-width': 3 } });
          made.addLayer({
            id: 'kv-markers',
            type: 'circle',
            source: 'kv-markers',
            paint: { 'circle-radius': 8, 'circle-color': ['case', ['get', 'stale'], muted, accent], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
          });
          setReady(true);
        });
        made.on('click', (event: MapLibre.MapMouseEvent) => pressed.current?.({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }));
        // The person moved it: it stops following until asked.
        made.on('dragstart', () => setFollowing(false));
        made.on('zoomstart', (event: { originalEvent?: unknown }) => {
          if (event.originalEvent) setFollowing(false);
        });
        map.current = made;
      })
      .catch((error: unknown) => setFailed((error as Error).message));
    return () => {
      gone = true;
      map.current?.remove();
      map.current = null;
      setReady(false);
      fitted.current = false;
    };
  }, [api]);

  // What it shows, set again as it changes; and where it looks.
  useEffect(() => {
    const shown = map.current;
    if (!shown || !ready) return;
    const set = (id: (typeof SOURCES)[number], data: unknown) => (shown.getSource(id) as MapLibre.GeoJSONSource | undefined)?.setData(data as Parameters<MapLibre.GeoJSONSource['setData']>[0]);
    set('kv-markers', markersGeoJSON(markers));
    set('kv-accuracy', accuracyGeoJSON(markers));
    set('kv-trails', trailsGeoJSON(trails));
    set('kv-zones', zonesGeoJSON(zones));
    set('kv-areas', areasGeoJSON(areas));
    set('kv-tracing', tracingGeoJSON(tracing ?? []));

    const followed = follow ? markers.find((marker) => marker.id === follow) : null;
    if (!fitted.current) {
      // At first: everything it shows, in view — a home's rooms close enough to tell apart.
      const box = boundsOf({ markers, trails, zones, areas, ...(drawing ? { areas: [...areas, { id: 'drawing', ring: [...drawing.corners, drawing.corners[0]] }] } : {}) }) ?? (centre ? around(centre) : null);
      if (box) {
        shown.fitBounds([box[0], box[1], box[2], box[3]], { padding: 48, maxZoom: areas.length || drawing || centre ? FIT_ZOOM_INDOORS : FIT_ZOOM, duration: 0 });
        fitted.current = true;
      }
    } else if (followed && following) {
      shown.easeTo({ center: [followed.longitude, followed.latitude], duration: 800 });
    }
  }, [ready, markers, trails, zones, areas, drawing, tracing, centre, follow, following]);

  // A floor's drawing, laid under its rooms: an image of its own, placed by its corners.
  useEffect(() => {
    const shown = map.current;
    if (!shown || !ready) return;
    const source = shown.getSource('kv-drawing') as MapLibre.ImageSource | undefined;
    if (!drawing) {
      if (source) (shown.removeLayer('kv-drawing'), shown.removeSource('kv-drawing'));
      return;
    }
    const coordinates = drawing.corners.map((corner) => [corner[0], corner[1]]) as [[number, number], [number, number], [number, number], [number, number]];
    if (source) source.updateImage({ url: drawing.url, coordinates });
    else {
      shown.addSource('kv-drawing', { type: 'image', url: drawing.url, coordinates });
      shown.addLayer({ id: 'kv-drawing', type: 'raster', source: 'kv-drawing', paint: { 'raster-opacity': 0.85 } }, 'kv-areas-fill');
    }
  }, [ready, drawing]);

  // A map that takes taps shows it.
  useEffect(() => {
    const canvas = map.current?.getCanvas();
    if (canvas) canvas.style.cursor = onPress ? 'crosshair' : '';
  }, [ready, Boolean(onPress)]);

  const zoom = (by: number) => map.current?.easeTo({ zoom: (map.current.getZoom() ?? 0) + by, duration: 250 });
  const recentre = () => {
    setFollowing(true);
    const box = boundsOf({ markers: follow ? markers.filter((marker) => marker.id === follow) : markers, trails: follow ? [] : trails, areas: follow ? [] : areas }) ?? (centre && !follow ? around(centre) : null);
    if (box) map.current?.fitBounds([box[0], box[1], box[2], box[3]], { padding: 48, maxZoom: !follow && areas.length ? FIT_ZOOM_INDOORS : FIT_ZOOM, duration: 600 });
  };

  if (!api || failed) {
    return (
      <YStack height={height} borderRadius="$4" backgroundColor="$backgroundPress" alignItems="center" justifyContent="center" padding="$4">
        <Text fontSize={13} color="$muted" textAlign="center">
          {failed ?? 'A map is drawn by a server: this app has none.'}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack height={height} borderRadius="$4" overflow="hidden" position="relative" backgroundColor="$backgroundPress" role="img" aria-label={label}>
      <div ref={holder} style={{ position: 'absolute', inset: 0 }} />
      <YStack position="absolute" top="$2" right="$2" gap="$1.5">
        <Control icon="plus" label="Closer" onPress={() => zoom(1)} />
        <Control icon="minus" label="Further" onPress={() => zoom(-1)} />
        <Control icon="crosshair" label={follow ? 'Back to it' : 'Back to everything'} onPress={recentre} lit={!following} />
      </YStack>
      <XStack position="absolute" left="$2" bottom="$1.5" backgroundColor="rgba(0,0,0,0.45)" paddingHorizontal="$1.5" borderRadius="$2">
        <Text fontSize={10} color="#ffffff" opacity={0.85}>
          {MAP_CREDIT}
        </Text>
      </XStack>
    </YStack>
  );
}

function Control({ icon, label, onPress, lit = false }: { icon: 'plus' | 'minus' | 'crosshair'; label: string; onPress: () => void; lit?: boolean }) {
  return (
    <YStack
      width={40}
      height={40}
      borderRadius="$3"
      alignItems="center"
      justifyContent="center"
      backgroundColor={lit ? '$accent' : 'rgba(20,20,20,0.85)'}
      role="button"
      aria-label={label}
      tabIndex={0}
      cursor="pointer"
      pressStyle={{ opacity: 0.7 }}
      onPress={onPress}
    >
      <Icon name={icon} size={18} color={lit ? '#000000' : '#ffffff'} />
    </YStack>
  );
}
