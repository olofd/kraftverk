import { Text, useTheme, XStack } from 'tamagui';

import { holderOf, type DeviceView } from '@kraftverk/api-client';
import { Icon } from '@kraftverk/ui';

import { HERE, HERE_PLATFORM } from '../../platform/here';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';

/**
 * Where the values on this screen go: the hardware, through whom — or nowhere,
 * while writes are refused. On a device where one wrong register permanently
 * bricks the machine, that is worth one line.
 */
export function WhereWritesGo({ device }: { device: DeviceView }) {
  const { screenProps } = useDevices();
  const { role } = useHome();
  const { readOnly } = screenProps(device);
  // Which holder is this screen's business, not a device package's: the app says where writes go.
  const holder = holderOf(device);
  const theme = useTheme();
  const [tone, icon, message] = readOnly
    ? (['$warning', 'lock', holder === 'this-node' || role === 'master' ? 'Read-only: writes from this app are off (App settings).' : 'Read-only: the server refuses every write.'] as const)
    : holder === 'this-node'
      ? (['$muted', 'smartphone', `Written to ${device.name} from this app.`] as const)
      : holder === 'master'
        ? role === 'follower'
          ? (['$muted', 'server', `Written to ${device.name} through your server.`] as const)
          : (['$muted', HERE_PLATFORM === 'web' ? 'monitor' : 'smartphone', `Written to ${device.name} from ${HERE}.`] as const)
        : (['$muted', 'link-2', device.health.detail] as const);

  return (
    <XStack alignItems="center" gap="$2.5" paddingHorizontal="$1">
      <Icon name={icon} size={13} color={theme[tone]?.val ?? theme.muted?.val} />
      <Text fontSize={12} color={tone} lineHeight={17} flex={1}>
        {message}
      </Text>
    </XStack>
  );
}
