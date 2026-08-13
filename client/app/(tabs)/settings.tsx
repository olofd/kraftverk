import { Screen } from '../../src/components/Screen';
import { NoStation } from '../../src/components/NoStation';
import { screensFor } from '../../src/devices/screens';
import { useDevices } from '../../src/state/DevicesProvider';
import { useStation } from '../../src/state/StationProvider';

/**
 * The app's frame around the station's own settings screen.
 *
 * Everything model-specific — the charging steps, the standby values, the
 * setting that must never be zero — lives in the device package. What is left
 * here is the page: a title, and the state the device screen needs, taken from
 * whichever link the app happens to be holding.
 *
 * Which device's settings these are is the catalog's answer, not this file's.
 * Any *other* device's settings are reached from its card on the Devices
 * screen, rendered generically from the schema it publishes — this tab exists
 * because the station's settings are the ones people open daily.
 */
export default function SettingsScreen() {
  const { status, settings, version, apiBaseUrl, source, updateSettings, togglePort } = useStation();
  const { station } = useDevices();

  const screens = screensFor(station);
  const readOnly = version?.readOnly ?? false;
  const simulated = status?.link.mode === 'simulator';

  if (!station || !screens || !status) {
    return (
      <Screen title="Settings">
        <NoStation />
      </Screen>
    );
  }

  const StationSettings = screens.settings;

  return (
    <Screen
      title="Settings"
      subtitle={
        readOnly
          ? 'Read-only — nothing here will reach the station'
          : simulated
            ? 'Simulator — not a real device'
            : `Written straight to ${station.record.name}`
      }
    >
      <StationSettings
        status={status}
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
