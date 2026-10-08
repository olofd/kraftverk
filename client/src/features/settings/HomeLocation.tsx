import { useState } from 'react';
import { Button, Input, Text, XStack, YStack } from 'tamagui';

import { describeError, type HomeView, type KraftverkApi } from '@kraftverk/api-client';
import { sunTimes, type Coordinates } from '@kraftverk/automation';
import { clockTime, localTime } from '@kraftverk/device-sdk';
import { Card, formatCoordinates, haptic, Row, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useFamilyApi } from '../../state/FamilyProvider';

/** Today's sunrise and sunset where the home is, on its own clock: "06:12 and 18:40" — or why there are none. */
function todaysSun(location: Coordinates, zone: string): string {
  const now = new Date();
  const today = localTime(now, zone);
  const { sunrise, sunset } = sunTimes({ year: today.year, month: today.month, day: today.day }, location);
  if (sunrise === null || sunset === null) return 'The sun neither rises nor sets there today.';
  return `Today the sun rises at ${clockTime(new Date(sunrise), zone)} and sets at ${clockTime(new Date(sunset), zone)}, on its clock.`;
}

/** A number typed as a person types it — "59,33" too — within ± `most`; null when it is not one. */
const degrees = (typed: string, most: number): number | null => {
  const value = Number(typed.trim().replace(',', '.'));
  return typed.trim() !== '' && Number.isFinite(value) && Math.abs(value) <= most ? value : null;
};

/** How big a geofence is when nobody said: a house and its garden. */
const RADIUS = 150;

/**
 * Where a home is: what an automation's `sunrise` and `sunset` are told by,
 * and what "at home" is measured from. Typed in degrees, as a map gives
 * them; today's sunrise and sunset said as soon as it is, so a mistake shows.
 */
export function HomeLocation({ home, onChanged, api: given }: { home: HomeView; onChanged: (home: HomeView) => void; api?: KraftverkApi }) {
  // The family's, or one given: a family being founded is not the app's yet.
  const family = useFamilyApi();
  const api = (given ?? family)!;
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const location = home.location;
  const typed = { latitude: degrees(latitude, 90), longitude: degrees(longitude, 180) };
  const save = async (next: Coordinates | null) => {
    haptic();
    setProblem(null);
    try {
      onChanged(await api.homes.update(home.id, { location: next ? { ...next, radius: home.location?.radius ?? RADIUS } : null }));
      setLatitude('');
      setLongitude('');
    } catch (err) {
      setProblem(describeError(err) || 'That did not work');
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Where it is</SectionLabel>
      <Card gap="$3">
        <Row
          title={location ? formatCoordinates(location) : 'Not said yet'}
          subtitle={location ? todaysSun(location, home.timeZone) : 'Say it, and automations can turn things on at sunset, or keep to the night: "time between sunset and sunrise".'}
        />
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <Input aria-label="Latitude" placeholder="Latitude, 59.33" flex={1} minWidth={120} size="$4" keyboardType="numbers-and-punctuation" value={latitude} onChangeText={setLatitude} />
          <Input aria-label="Longitude" placeholder="Longitude, 18.07" flex={1} minWidth={120} size="$4" keyboardType="numbers-and-punctuation" value={longitude} onChangeText={setLongitude} />
        </XStack>
        <Text fontSize={12} color="$muted" lineHeight={17}>
          In degrees, as a map gives them: north and east are positive, south and west negative.
        </Text>
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" disabled={typed.latitude === null || typed.longitude === null} opacity={typed.latitude === null || typed.longitude === null ? 0.5 : 1} onPress={() => void save({ latitude: typed.latitude!, longitude: typed.longitude! })}>
            {location ? 'Move it here' : 'Save'}
          </Button>
          {location ? (
            <Button size="$3" minHeight={44} chromeless color="$muted" onPress={() => void save(null)}>
              Forget it
            </Button>
          ) : null}
        </XStack>
      </Card>
      {problem ? <ErrorText fontSize={12}>{problem}</ErrorText> : null}
    </YStack>
  );
}
