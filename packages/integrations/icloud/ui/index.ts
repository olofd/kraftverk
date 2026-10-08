import type { DeviceUi } from '@kraftverk/api-client';

import { FindMyDashboard } from './dashboard.tsx';

/**
 * A Find My device's own screens, found by the app through `kraftverk.ui` in
 * this package's package.json. Its dashboard only: its settings and its tools
 * (lost mode, locate now) are drawn by the app from what the type declares.
 */
export default {
  dashboard: FindMyDashboard,
} satisfies DeviceUi;
