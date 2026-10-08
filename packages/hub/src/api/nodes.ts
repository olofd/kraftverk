import { ApiError, type Caller, type KraftverkApi, type NodeView } from '@kraftverk/api-contract';
import { checkValue, nodeId as asNodeId, savedDeviceId, validateDescription, type AuditSubject, type Reading } from '@kraftverk/device-sdk';
import { deviceStore, type NodeRecord } from '@kraftverk/store';

import { loggedAttributes, recordChanges } from '../history/changes.ts';
import { SKEW_MS } from '../history/retention.ts';

/** A node's clock this close to the master's is taken as it is: what it sent is moved only when it is further off. */
const CLOCK_TOLERANCE_MS = 2_000;
import { keptAttributes } from '../history/sampler.ts';
import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/*
  The nodes of the home (docs/DATA-MODEL.md §3) — its master, and the nodes
  that follow it: a phone, a browser, another machine — and what a node sends
  the master for a connection it holds (§4): it runs the device's session;
  the master still keeps its history, its store and its timeline. A node a
  person joined is their account's, and speaks for its own connections and
  nobody else's.
*/

/** A device's stored value is kept up to this size. */
const STORE_VALUE_MAX = 256 * 1024;

const STORE_KEY = /^[\w.:-]{1,80}$/;

/** A node of the home, as everything that uses the home sees it: `account`, who asks — whether it is theirs to forget. */
function nodeView(node: NodeRecord, masterId: string, account: string | null | undefined): NodeView {
  return {
    id: node.id,
    name: node.name,
    platform: node.platform,
    transports: node.transports,
    alwaysOn: node.alwaysOn,
    reachable: node.reachable,
    trusted: node.trusted,
    master: node.id === masterId,
    yours: account !== undefined && !node.self && node.id !== masterId && node.accountId === account,
    createdAt: node.createdAt,
    lastSeenAt: node.lastSeenAt,
  };
}

export function nodesApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'nodes' | 'held'> {
  const { catalog, connections, nodes, heldReadings, sessions, events } = hub;
  const actor = actorOf(caller);
  /** Whose nodes a caller's are: a person's account. An assistant has none; a home with no accounts, its owner's, which act for nobody. */
  const account = caller.kind === 'person' ? (caller.account ?? null) : undefined;

  /** One of the caller's nodes, or none they have: a node's id is not a secret, so it is checked against the account every time. */
  const ownNode = (id: string): NodeRecord => {
    const node = nodes.get(id);
    if (account === undefined || !node || node.self || node.accountId !== account) throw new ApiError('not-found', 'No such node');
    // Heard from — its readings, its timeline, its store: what "heard … ago" says.
    nodes.seen(node.id);
    return node;
  };
  /** The device, the node and the connection a call is about — all three checked. */
  const heldBy = (deviceId: string, input: { nodeId: string; connectionId: string }) => {
    const device = catalog.active(savedDeviceId(deviceId));
    if (!device) throw new ApiError('not-found', 'No such device');
    const node = ownNode(input.nodeId);
    const connection = connections.get(input.connectionId);
    if (!connection || connection.deviceId !== device.id || connection.heldBy !== node.id) throw new ApiError('forbidden', 'That node does not hold a connection to this device');
    return { device, node, connection };
  };
  const masterId = () => hub.home.get()!.masterId;

  return {
    nodes: {
      list: async () => nodes.all().map((node) => nodeView(node, masterId(), account)),

      /**
       * A node joins the home — to follow it, and hold for it the ways it
       * reaches — by its own id, saying what it is, at every start: so "held
       * by Olof's iPhone" has something to name, and setup knows what it can
       * hold. From a person's account, as theirs.
       */
      async join(node) {
        if (account === undefined) throw new ApiError('forbidden', 'Sign in first');
        try {
          return nodeView(nodes.join({ ...node, id: asNodeId(node.id) }, account), masterId(), account);
        } catch (error) {
          throw new ApiError('conflict', (error as Error).message);
        }
      },

      /** Forgets a node, and every connection it held. Never the master, nor another person's. */
      async forget(id) {
        const node = ownNode(id);
        if (node.id === masterId()) throw new ApiError('conflict', 'The home’s master is not forgotten: another node takes its place first');
        nodes.remove(node.id);
        hub.audit.record({ at: new Date().toISOString(), kind: 'node.forgotten', actor, resourceKind: 'node', resource: node.id, summary: `Forgot "${node.name}" and every connection it held` });
        await sessions.sync(catalog.list());
        hub.bus.publish({ kind: 'changed', deviceId: null });
      },
    },

    held: {
      /** Readings the node took: live ones become the device's state, queued ones go straight into history. */
      async readings(deviceId, input) {
        const { device, node, connection } = heldBy(deviceId, input);
        /*
          The same rule as a connection the home holds: a device saved before
          it ever answered learns who it is the first time it does, and a
          connection that now reaches a different device adds nothing to this
          one's history.
        */
        const said = input.identity ?? null;
        if (said && device.identity && said.toLowerCase() !== device.identity.toLowerCase()) {
          hub.audit.record({ at: new Date().toISOString(), kind: 'device.mismatch', actor, resourceKind: 'device', resource: device.id, summary: `${device.name}'s connection from ${node.name} reaches ${said} instead`, detail: { expected: device.identity } });
          throw new ApiError('conflict', 'That connection reaches a different device, not the one you added');
        }
        // What every open screen's list shows changes only when the device does, or comes back: then it reads the list again.
        let listChanged = heldReadings.latest(device.id) === null;
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
        // On this clock: the node's own may be fast or slow, and said what it read when by it.
        const sentAt = input.sentAt ? Date.parse(input.sentAt) : Number.NaN;
        const offset = Number.isFinite(sentAt) && Math.abs(Date.now() - sentAt) > CLOCK_TOLERANCE_MS ? Date.now() - sentAt : 0;
        // On this clock, and in UTC: history keys its hours by the time as written.
        const onOurClock = (at: string) => new Date(Date.parse(at) + offset).toISOString();
        /*
          Held to what the device is, as a session's own readings are: an
          attribute it has, a value of the type it declares — or none — and a
          time that is one. What is not is refused, and counted.
        */
        const attributes = new Map(description.attributes.map((attribute) => [attribute.key, attribute]));
        const readings = input.readings.flatMap((reading): Reading[] => {
          const attribute = attributes.get(reading.key);
          if (!attribute || !Number.isFinite(Date.parse(reading.at))) return [];
          if (reading.value !== null && !checkValue(attribute.value, reading.value).ok) return [];
          const confirmed = reading.confirmedAt && Number.isFinite(Date.parse(reading.confirmedAt)) ? { confirmedAt: onOurClock(reading.confirmedAt) } : {};
          return [{ key: reading.key, value: reading.value, at: onOurClock(reading.at), ...confirmed }];
        });
        const accepted = heldReadings.accept(device.id, { nodeId: node.id, connectionId: connection.id }, readings, keptAttributes(description));
        const counts = { ...accepted, refused: accepted.refused + input.readings.length - readings.length };
        // What it reads now, said on the live stream as a device the home holds says it; the rest went to history.
        const latest = heldReadings.latest(device.id);
        if (counts.live && latest) hub.bus.publish({ kind: 'readings', deviceId: device.id, readings: latest.readings });
        if (listChanged && latest) hub.bus.publish({ kind: 'changed', deviceId: device.id });
        // Its on/offs and modes, when each changed: queued ones land in their place in time.
        recordChanges(hub.history, device.id, loggedAttributes(description), readings);
        // Its events, kept as the home's own are: only what its description declares, at the level it declares.
        for (const event of input.events ?? []) {
          const declared = (description.events ?? []).find((spec) => spec.id === event.id);
          const at = Date.parse(onOurClock(event.at));
          if (!declared || !Number.isFinite(at) || at > Date.now() + SKEW_MS) continue;
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
       * The entries a node's gateway and sessions wrote while it held a
       * connection — queued while offline, sent when it can. The actor is
       * always whoever is signed in, whatever the entry says, and the node
       * is recorded.
       */
      async audit(nodeId, entries) {
        const node = ownNode(asNodeId(nodeId));
        for (const entry of entries) {
          const at = Number.isFinite(Date.parse(entry.at)) ? new Date(entry.at).toISOString() : new Date().toISOString();
          const about = (entry.resource === undefined ? {} : { resourceKind: entry.resourceKind, resource: entry.resource }) as AuditSubject;
          hub.audit.record({ at, kind: entry.kind, summary: entry.summary, ...about, actor, detail: { from: { node: node.id, name: node.name }, ...(entry.detail === undefined ? {} : { detail: entry.detail }) } });
        }
        return { recorded: entries.length };
      },
    },
  };
}
