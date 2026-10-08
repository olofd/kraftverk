import { YStack, XStack } from 'tamagui';

/*
  A Find My device drawn as what it is — a phone, a tablet, a Mac, a watch,
  earbuds — from plain shapes, in the app's own colours: no picture of
  Apple's, and one look across every kind. Its screen glows faintly while it
  charges.
*/

export type Kind = 'phone' | 'tablet' | 'computer' | 'watch' | 'earbuds' | 'other';

const LINE = '$color';
const GLASS = '$backgroundPress';

/** Its drawing, `height` tall. */
export function DeviceDrawing({ kind, height = 88, charging = false }: { kind: Kind; height?: number; charging?: boolean }) {
  const glass = charging ? '$accent' : GLASS;
  const glow = charging ? 0.25 : 1;
  const unit = height / 88;
  switch (kind) {
    case 'phone':
      return (
        <YStack width={44 * unit} height={88 * unit} borderRadius={10 * unit} borderWidth={2.5 * unit} borderColor={LINE} padding={3 * unit} aria-hidden>
          <YStack flex={1} borderRadius={7 * unit} backgroundColor={glass} opacity={glow} alignItems="center">
            {/* Its island, where the camera is. */}
            <YStack marginTop={4 * unit} width={14 * unit} height={4 * unit} borderRadius={2 * unit} backgroundColor={LINE} />
          </YStack>
        </YStack>
      );
    case 'tablet':
      return (
        <YStack width={66 * unit} height={88 * unit} borderRadius={8 * unit} borderWidth={2.5 * unit} borderColor={LINE} padding={4 * unit} aria-hidden>
          <YStack flex={1} borderRadius={4 * unit} backgroundColor={glass} opacity={glow} />
        </YStack>
      );
    case 'computer':
      return (
        <YStack alignItems="center" aria-hidden>
          <YStack width={92 * unit} height={60 * unit} borderTopLeftRadius={6 * unit} borderTopRightRadius={6 * unit} borderWidth={2.5 * unit} borderColor={LINE} padding={4 * unit}>
            <YStack flex={1} borderRadius={2 * unit} backgroundColor={glass} opacity={glow} />
          </YStack>
          {/* Its base, wider than its screen. */}
          <YStack width={112 * unit} height={6 * unit} borderBottomLeftRadius={4 * unit} borderBottomRightRadius={4 * unit} backgroundColor={LINE} />
        </YStack>
      );
    case 'watch':
      return (
        <YStack alignItems="center" aria-hidden>
          <YStack width={28 * unit} height={18 * unit} borderTopLeftRadius={6 * unit} borderTopRightRadius={6 * unit} backgroundColor={LINE} opacity={0.5} />
          <XStack alignItems="center">
            <YStack width={46 * unit} height={52 * unit} borderRadius={14 * unit} borderWidth={2.5 * unit} borderColor={LINE} padding={4 * unit}>
              <YStack flex={1} borderRadius={9 * unit} backgroundColor={glass} opacity={glow} />
            </YStack>
            {/* Its crown. */}
            <YStack width={4 * unit} height={12 * unit} borderRadius={2 * unit} backgroundColor={LINE} />
          </XStack>
          <YStack width={28 * unit} height={18 * unit} borderBottomLeftRadius={6 * unit} borderBottomRightRadius={6 * unit} backgroundColor={LINE} opacity={0.5} />
        </YStack>
      );
    case 'earbuds':
      return (
        <XStack gap={14 * unit} alignItems="flex-start" aria-hidden>
          {[0, 1].map((side) => (
            <YStack key={side} alignItems={side === 0 ? 'flex-end' : 'flex-start'}>
              <YStack width={26 * unit} height={26 * unit} borderRadius={13 * unit} borderWidth={2.5 * unit} borderColor={LINE} backgroundColor={glass} />
              <YStack width={9 * unit} height={46 * unit} borderRadius={4.5 * unit} backgroundColor={LINE} marginTop={-6 * unit} marginHorizontal={3 * unit} />
            </YStack>
          ))}
        </XStack>
      );
    default:
      return <YStack width={60 * unit} height={60 * unit} borderRadius={14 * unit} borderWidth={2.5 * unit} borderColor={LINE} backgroundColor={glass} opacity={glow} aria-hidden />;
  }
}

/** Its charge, drawn as a battery: how full, red when low, with a bolt while it charges. */
export function Battery({ percent, charging }: { percent: number | null; charging: boolean | null }) {
  const level = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const tone = charging ? '$success' : level <= 20 ? '$danger' : '$color';
  return (
    <XStack alignItems="center" aria-hidden>
      <YStack width={46} height={22} borderRadius={6} borderWidth={2} borderColor="$muted" padding={2}>
        <YStack width={`${level}%`} height="100%" borderRadius={3} backgroundColor={tone} />
      </YStack>
      <YStack width={3} height={8} borderTopRightRadius={2} borderBottomRightRadius={2} backgroundColor="$muted" />
    </XStack>
  );
}
