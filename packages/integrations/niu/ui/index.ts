import type { DeviceUi } from '@kraftverk/api-client';

import { ScooterDashboard } from './dashboard.tsx';

/**
 * A NIU scooter's own screens, found by the app through `kraftverk.ui` in
 * this package's package.json — and in each model's, which shows these until
 * it has reason to differ. Its dashboard only: its settings are its
 * connection's, which the app draws.
 */
export default {
  dashboard: ScooterDashboard,
} satisfies DeviceUi;
