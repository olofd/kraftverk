import { ApiError, type Caller, type KraftverkApi } from '@kraftverk/api-contract';
import { clientId as asClientId, savedDeviceId, validateDescription, type AuditSubject } from '@kraftverk/device-sdk';
import { deviceStore, type ClientRecord } from '@kraftverk/store';

import { loggedAttributes, recordChanges } from '../history/changes.ts';
import { keptAttributes } from '../history/sampler.ts';
import type { Hub } from '../hub.ts';
import { actorOf } from './caller.ts';

/*
  The phones and browsers that hold connections for this home, and what each
  sends for a connection it holds (docs/DATA-MODEL.md §4): the app runs the
  device's session; the home still keeps its history, its store and its
  timeline. An app is its account's, and speaks for its own connections and
  nobody else's.
*/

/** A device's stored value is kept up to this size. */
const STORE_VALUE_MAX = 256 * 1024;
const STORE_KEY = /^[\w.:-]{1,80}$/;

export function heldApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'apps' | 'held'> {
  const { catalog, connections, clients, remote, sessions, events } = hub;
  const actor = actorOf(caller);
  /** Whose apps a caller's are: a person's account. An assistant, or a home with no accounts, has none. */
  const account = caller.kind === 'person' ? (caller.account ?? null) : null;

  /** One of the caller's apps, or none they have: an app's id is not a secret, so it is checked against the account every time. */
  const ownApp = (id: string): ClientRecord => {
    const app = clients.get(id);
    if (!account || !app || app.userId !== account) throw new ApiError('not-found', 'No such app');
    return app;
  };
  /** The device, the app and the connection a call is about — all three checked. */
  const heldBy = (deviceId: string, input: { clientId: string; connectionId: string }) => {
    const device = catalog.active(savedDeviceId(deviceId));
    if (!device) throw new ApiError('not-found', 'No such device');
    const app = ownApp(input.clientId);
    const connection = connections.get(input.connectionId);
    if (!connection || connection.deviceId !== device.id || connection.heldBy !== app.id) throw new ApiError('forbidden', 'That app does not hold a connection to this device');
    return { device, app, connection };
  };

  return {
    apps: {
      /** An app says who it is and what it reaches devices over, at every start: so "held by Olof's iPhone" has something to name, and setup knows what it can hold. */
      async register(input) {
        if (!account) throw new ApiError('forbidden', 'Sign in first');
        return clients.register({ ...input, userId: account });
      },

      async list() {
        if (!account) throw new ApiError('forbidden', 'Sign in first');
        return clients.forUser(account);
      },

      /** Forgets a phone or browser, and every connection it held. */
      async forget(id) {
        const app = ownApp(id);
        clients.remove(app.id);
        hub.audit.record({ at: new Date().toISOString(), kind: 'client.forgotten', actor, resourceKind: 'client', resource: app.id, summary: `Forgot "${app.name}" and every connection it held` });
        await sessions.sync(catalog.list());
        hub.bus.publish({ kind: 'changed', deviceId: null });
      },
    },

    held: {
      /** Readings the app took: live ones become the device's state, queued ones go straight into history. */
      async readings(deviceId, input) {
        const { device, app, connection } = heldBy(deviceId, input);
        /*
          The same rule as a connection the home holds: a device saved before
          it ever answered learns who it is the first time it does, and a
          connection that now reaches a different device adds nothing to this
          one's history.
        */
        const said = input.identity ?? null;
        if (said && device.identity && said.toLowerCase() !== device.identity.toLowerCase()) {
          hub.audit.record({ at: new Date().toISOString(), kind: 'device.mismatch', actor, resourceKind: 'device', resource: device.id, summary: `${device.name}'s connection from ${app.name} reaches ${said} instead`, detail: { expected: device.identity } });
          throw new ApiError('conflict', 'That connection reaches a different device, not the one you added');
        }
        // What every open screen's list shows changes only when the device does, or comes back: then it reads the list again.
        let listChanged = remote.latest(device.id) === null;
        if (said && !device.identity && !catalog.byIdentity(said).active) {
          catalog.update(device.id, { identity: said });
          hub.audit.record({ at: new Date().toISOString(), kind: 'device.identified', actor, resourceKind: 'device', resource: device.id, summary: `${device.name} answered for the first time, as ${said}` });
          listChanged = true;
        }
        if (input.description) {
          const problems = validateDescription(input.description, device.typeId);
          if (problems.length) throw new ApiError('invalid', `That description does not hold: ${problems.join('; ')}`);
          // Sent only when the device describes itself: the type's own the home has already.
          if (catalog.describe(device.id, input.description, input.info ?? null, 'device')) listChanged = true;
        }
        const description = sessions.description(catalog.get(device.id)!);
        const counts = remote.accept(device.id, { clientId: app.id, connectionId: connection.id }, input.readings, keptAttributes(description));
        // What it reads now, said on the live stream as a device the home holds says it; the rest went to history.
        const latest = remote.latest(device.id);
        if (counts.live && latest) hub.bus.publish({ kind: 'readings', deviceId: device.id, readings: latest.readings });
        if (listChanged && latest) hub.bus.publish({ kind: 'changed', deviceId: device.id });
        // Its on/offs and modes, when each changed: queued ones land in their place in time.
        recordChanges(hub.db, device.id, loggedAttributes(description), input.readings);
        // Its events, kept as the home's own are: only what its description declares, at the level it declares.
        for (const event of input.events ?? []) {
          const declared = (description.events ?? []).find((spec) => spec.id === event.id);
          const at = Date.parse(event.at);
          if (!declared || !Number.isFinite(at) || at > Date.now() + 60_000) continue;
          const kept = { id: event.id, level: declared.level, part: event.part ?? declared.part ?? null, data: event.data, at: new Date(at).toISOString() };
          events.record(device.id, kept);
          hub.bus.publish({ kind: 'event', deviceId: device.id, event: kept });
        }
        connections.touch(connection.id);
        return counts;
      },

      /** The device's own store, which a session keeps between runs: a baseline, a detected protocol version. */
      async store(deviceId) {
        const device = catalog.active(savedDeviceId(deviceId));
        if (!device) throw new ApiError('not-found', 'No such device');
        return catalog.storeOf(device.id);
      },

      async keep(deviceId, key, input) {
        if (!STORE_KEY.test(key)) throw new ApiError('invalid', 'That is not a store key');
        const { device } = heldBy(deviceId, input);
        if (JSON.stringify(input.value ?? null).length > STORE_VALUE_MAX) throw new ApiError('too-large', 'That value is too large to keep');
        const store = deviceStore(hub.db, device.id);
        if (input.value === null || input.value === undefined) store.delete(key);
        else store.set(key, input.value);
      },

      /**
       * The entries an app's gateway and sessions wrote while it held a
       * connection — queued while offline, sent when it can. The actor is
       * always whoever is signed in, whatever the entry says, and the app is
       * recorded.
       */
      async audit(appId, entries) {
        const app = ownApp(asClientId(appId));
        for (const entry of entries) {
          const at = Number.isFinite(Date.parse(entry.at)) ? new Date(entry.at).toISOString() : new Date().toISOString();
          const about = (entry.resource === undefined ? {} : { resourceKind: entry.resourceKind, resource: entry.resource }) as AuditSubject;
          hub.audit.record({ at, kind: entry.kind, summary: entry.summary, ...about, actor, detail: { from: { client: app.id, name: app.name }, ...(entry.detail === undefined ? {} : { detail: entry.detail }) } });
        }
        return { recorded: entries.length };
      },
    },
  };
}
