import { Screen } from '../../src/components/Screen';
import { NoStation } from '../../src/components/NoStation';
import { screensFor } from '../../src/devices/screens';
import { useDevices } from '../../src/state/DevicesProvider';
import { useStation } from '../../src/state/StationProvider';

/**
 * The app's frame around the station's dashboard.
 *
 * Which dashboard that is comes from the device model, not from an assumption:
 * the station is looked up in the catalog, and the screens table says who draws
 * it. The title is the name *you* gave it — the station's own idea of what it
 * is called is a fact about the hardware, and belongs under the name, not in
 * place of it.
 *
 * Every pixel below the title belongs to the device package.
 */
export default function DashboardScreen() {
  const { status, settings, version, apiBaseUrl, source, direct, togglePort, updateSettings } =
    useStation();
  const { station } = useDevices();

  const screens = screensFor(station);

  if (!station || !screens) {
    return (
      <Screen title="Dashboard">
        <NoStation />
      </Screen>
    );
  }

  const Dashboard = screens.dashboard;

  return (
    <Screen title={station.record.name} subtitle={station.description}>
      <Dashboard
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
