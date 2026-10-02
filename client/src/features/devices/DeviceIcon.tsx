import { useTheme } from 'tamagui';

import { isOnline, type DeviceView } from '@kraftverk/api-client';
import { Icon } from '@kraftverk/ui';

import { featherName } from '../../components/icons';

/** A device's icon, its type's: lit while it can be reached. */
export function DeviceIcon({ device, size = 16 }: { device: DeviceView; size?: number }) {
  const theme = useTheme();
  return <Icon name={featherName(device.meta.icon, 'zap')} size={size} color={isOnline(device.health) ? theme.accent?.val : theme.muted?.val} />;
}
