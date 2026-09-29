import type { DeviceUi } from '@kraftverk/api-client';

import { StationDashboard } from './dashboard.tsx';
import { StationRegisters } from './registers.tsx';
import { StationSettings } from './settings.tsx';

/**
 * The P280's own screens, found by the app through `kraftverk.ui` in this
 * package's package.json and bound in its generated registry. Every other
 * device gets the app's generic screens; a device with screens of its own
 * adds them here, and the app shell learns nothing about it.
 */
export default {
  dashboard: StationDashboard,
  settings: StationSettings,
  tools: {
    label: 'Registers',
    description: 'Register dumps and the snapshot-and-diff workflow, for checking the map against real hardware',
    Screen: StationRegisters,
  },
} satisfies DeviceUi;
