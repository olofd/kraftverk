import { ApiError, type Caller, type KraftverkApi } from '@kraftverk/api-contract';
import { isLinkKind, linkFits, linkKindSpec, partName, partsOf, savedDeviceId } from '@kraftverk/device-sdk';

import type { Hub } from '../node/hub.ts';
import { checkSecretFields } from '../installed/connection-schema.ts';
import { scopeOf } from './scope.ts';

/*
  How each device is reached, and how devices fit the house (docs/DATA-MODEL.md
  §3, §4), as everything that uses a home asks: a connection preferred,
  removed, its secrets replaced or let leave in plain text; a link between
  two parts added or taken away. A connection is added by setup, never here.
*/

export function connectionsApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'connections' | 'links'> {
  const { catalog, connections, links, sessions } = hub;
  const { protocols } = hub.installed;
  const { record, changed, deviceOf, viewOf, connectionOf } = scopeOf(hub, caller);

  /** "Garage station — Mains", or a device's name for its main part: how a link's ends read on the timeline. */
  const endName = (end: { device: string; part: string }): string => {
    const device = catalog.get(savedDeviceId(end.device));
    if (!device) return 'a removed device';
    const part = partsOf(device.removedAt ? device.description : sessions.description(device)).find((candidate) => candidate.id === end.part);
    return partName(device.name, end.part, part?.label ?? end.part);
  };

  return {
    connections: {
      /** Makes this the way to reach the device, whenever it can be reached. */
      async prefer(deviceId, connectionId) {
        const { device, connection } = connectionOf(deviceId, connectionId);
        connections.prefer(connection.id);
        record('device.connection-preferred', 'device', device.id, `"${device.name}" is now reached by ${connection.method} first`);
        await sessions.sync(catalog.list());
        changed();
        return viewOf(device.id);
      },

      /** Removes one way to reach a device. Not the last: that is removing the device. */
      async remove(deviceId, connectionId) {
        const { device, connection } = connectionOf(deviceId, connectionId);
        if (connections.forDevice(device.id).length <= 1) throw new ApiError('conflict', 'This is the only way to reach it. Remove the device instead.');
        connections.remove(connection.id);
        record('device.connection-removed', 'device', device.id, `"${device.name}" is no longer reached by ${connection.method} (${connection.address})`);
        await sessions.sync(catalog.list());
        changed();
        return viewOf(device.id);
      },

      /** Replaces a connection's secrets, held by this home: a plug's local key can change every time it is paired again. Write-only, like every secret. */
      async setSecrets(deviceId, connectionId, given) {
        const { device, connection } = connectionOf(deviceId, connectionId);
        if (connection.heldBy !== hub.self.id) throw new ApiError('conflict', 'That connection’s secrets are kept by the node that holds it');
        const method = sessions.typeOf(device)?.connections.find((candidate) => candidate.id === connection.method) ?? null;
        checkSecretFields(method, method ? protocols.get(method.protocol) : null, given);
        connections.setSecrets(connection.id, given);
        // Which fields, never their values.
        record('device.secrets-changed', 'device', device.id, `Changed ${Object.keys(given).join(', ')} for "${device.name}"`);
        // Reopened, so the new key is used now rather than at the next restart.
        await sessions.close(device.id);
        await sessions.sync(catalog.list());
        changed();
        return viewOf(device.id);
      },

      /** Whether a connection's secrets may leave in an export as plain text: its owner's choice, off unless chosen. */
      async setExportable(deviceId, connectionId, exportable) {
        const { device, connection } = connectionOf(deviceId, connectionId);
        if (connection.heldBy !== hub.self.id) throw new ApiError('conflict', 'That connection’s secrets are kept by the node that holds it, and never exported');
        if (exportable !== connection.secretsExportable) {
          connections.update(connection.id, { secretsExportable: exportable });
          record(
            'device.exportable',
            'device',
            device.id,
            exportable ? `"${device.name}": its ${connection.method} secrets may now leave in an export as plain text` : `"${device.name}": its ${connection.method} secrets no longer leave in plain text`,
            { connection: connection.id, secretsExportable: exportable }
          );
          changed();
        }
        return viewOf(device.id);
      },
    },

    links: {
      /** Records a fact about the house, between two parts: this plug's relay feeds that station's mains input. */
      async add(input) {
        if (!isLinkKind(input.kind)) throw new ApiError('invalid', `There is no link called "${input.kind}"`);
        const source = deviceOf(input.source.device);
        const target = deviceOf(input.target.device);
        if (source.id === target.id) throw new ApiError('invalid', 'A device cannot be linked to itself');
        const kind = linkKindSpec(input.kind);
        if (!linkFits(input.kind, sessions.description(source), input.source.part, sessions.description(target), input.target.part)) {
          throw new ApiError('invalid', `"${endName(input.source)}" cannot be said to ${kind.verb.replace(/s$/, '')} "${endName(input.target)}": the one must offer ${kind.from}, the other ${kind.to}`);
        }
        const link = links.add({ kind: input.kind, source: { device: source.id, part: input.source.part }, target: { device: target.id, part: input.target.part } });
        record('device.linked', 'device', source.id, `"${endName(link.source)}" ${kind.verb} "${endName(link.target)}"`, { kind: link.kind, source: link.source, target: link.target });
        changed();
        return link;
      },

      async remove(id) {
        const link = links.get(id);
        if (!link) throw new ApiError('not-found', 'No such link');
        links.remove(link.id);
        record('device.unlinked', 'device', link.source.device, `"${endName(link.source)}" no longer ${linkKindSpec(link.kind).verb} "${endName(link.target)}"`);
        changed();
      },
    },
  };
}
