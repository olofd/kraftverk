import { Screen } from '../../src/components/Screen';
import { NoStation } from '../../src/components/NoStation';
import { screensFor } from '../../src/devices/screens';
import { useDevices } from '../../src/state/DevicesProvider';
import { useStation } from '../../src/state/StationProvider';

/**
 * The app's frame around the station's protocol screen.
 *
 * The register map, the snapshot-and-diff workflow and everything it knows about
 * Sydpower framing belong to the device package. This file supplies the page and
 * the link the screen should read through — and asks the screens table whose
 * protocol screen that is, rather than assuming there is only one.
 */
export default function ProtocolScreen() {
  const { status, version, source, direct } = useStation();
  const { station } = useDevices();

  const screens = screensFor(station);

  if (!screens) {
    return (
      <Screen title="Protocol">
        <NoStation />
      </Screen>
    );
  }

  const StationProtocol = screens.protocol;

  return (
    <Screen title="Protocol" subtitle="Verify the register map against real hardware">
      <StationProtocol status={status} version={version} source={source} direct={direct} />
    </Screen>
  );
}
