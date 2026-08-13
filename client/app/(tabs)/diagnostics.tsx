import { StationProtocol } from '@kraftverk/device-aferiy-p280/ui/protocol';

import { Screen } from '../../src/components/Screen';
import { useStation } from '../../src/state/StationProvider';

/**
 * The app's frame around the P280's protocol screen.
 *
 * The register map, the snapshot-and-diff workflow and everything it knows about
 * Sydpower framing belong to the device package. This file supplies the page and
 * the link the screen should read through.
 */
export default function ProtocolScreen() {
  const { status, version, source, direct } = useStation();

  return (
    <Screen title="Protocol" subtitle="Verify the register map against real hardware">
      <StationProtocol status={status} version={version} source={source} direct={direct} />
    </Screen>
  );
}
