import { StationDashboard } from '@kraftverk/device-aferiy-p280/ui/dashboard';

import { Screen } from '../../src/components/Screen';
import { useStation } from '../../src/state/StationProvider';

/**
 * The app's frame around the P280's dashboard.
 *
 * Every pixel below the title belongs to the device package. When a second
 * device type arrives, this file picks whose dashboard to show and still knows
 * nothing about either.
 */
export default function DashboardScreen() {
  const { status, settings, version, apiBaseUrl, source, direct, togglePort, updateSettings } =
    useStation();

  return (
    <Screen title={status?.name ?? 'Dashboard'} subtitle={status?.model}>
      <StationDashboard
        status={status}
        settings={settings}
        version={version}
        readOnly={version?.readOnly ?? false}
        simulated={status?.link.mode === 'simulator'}
        direct={source === 'direct'}
        resuming={direct.resuming}
        linkLabel={source === 'direct' ? direct.support.label : undefined}
        apiBaseUrl={apiBaseUrl}
        updateSettings={updateSettings}
        togglePort={togglePort}
      />
    </Screen>
  );
}
