import { useTheme } from 'tamagui';

import { isOnline, type DeviceView } from '@kraftverk/api-client';
import { Icon } from '@kraftverk/ui';

import { featherName } from '../../components/icons';

/**
 * What every device gets for free.
 *
 * Written against its description: a section for each of its parts, the
 * controls from the commands its parts take, the rows from what they report,
 * the settings form from the attributes it can be told, and its connections
 * and links from the data model. Nothing here knows what a power station is —
 * a plug added next year lands on these panels with no code written for it.
 */

export function DeviceIcon({ device, size = 16 }: { device: DeviceView; size?: number }) {
  const theme = useTheme();
  return <Icon name={featherName(device.meta.icon, 'zap')} size={size} color={isOnline(device.health) ? theme.accent?.val : theme.muted?.val} />;
}
