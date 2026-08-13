import { StationSettings } from '@kraftverk/device-aferiy-p280/ui/settings';

import { Screen } from '../../src/components/Screen';
import { useStation } from '../../src/state/StationProvider';

/**
 * The app's frame around the P280's own settings screen.
 *
 * Everything model-specific — the charging steps, the standby values, the
 * setting that must never be zero — lives in the device package. What is left
 * here is the page: a title, and the state the device screen needs, taken from
 * whichever link the app happens to be holding.
 *
 * When a second device type arrives, this file chooses whose screen to render.
 * It does not learn anything about either.
 */
export default function SettingsScreen() {
  const { status, settings, version, apiBaseUrl, source, updateSettings, togglePort } = useStation();

  const readOnly = version?.readOnly ?? false;
  const simulated = status?.link.mode === 'simulator';

  return (
    <Screen
      title="Settings"
      subtitle={
        readOnly
          ? 'Read-only — nothing here will reach the station'
          : simulated
            ? 'Simulator — not a real device'
            : 'Written straight to the P280'
      }
    >
      <StationSettings
        status={status!}
        settings={settings}
        readOnly={readOnly}
        simulated={Boolean(simulated)}
        direct={source === 'direct'}
        apiBaseUrl={apiBaseUrl}
        updateSettings={updateSettings}
        togglePort={togglePort}
      />
    </Screen>
  );
}
