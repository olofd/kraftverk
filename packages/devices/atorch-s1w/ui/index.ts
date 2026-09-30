import type { DeviceUi } from '@kraftverk/api-client';

import { PlugDashboard } from './dashboard.tsx';
import { PlugSettings } from './settings.tsx';

/**
 * The ATORCH's own screens, found by the app through `kraftverk.ui` in this
 * package's package.json. What the plug says, in words a person understands,
 * and its settings as controls rather than numbers to type.
 */
export default {
  dashboard: PlugDashboard,
  settings: PlugSettings,
} satisfies DeviceUi;
