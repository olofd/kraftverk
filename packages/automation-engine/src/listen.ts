import type { RunLogKey, RunLogReach, RunLogReading, RunLogRole } from '@kraftverk/api-contract';
import { MAIN_PART, quantityOf, unitOf, type Clock, type DeviceDescription, type Reading } from '@kraftverk/device-sdk';

import type { AutomationEngineDeps, EngineDevice } from './model.ts';
import type { LiveRun } from './runs.ts';
import type { AutomationStorage } from './storage.ts';

/*
  A run's log (docs/SEQUENCES.md): the devices and roles it uses, then every
  reading each device gives while it runs, and whether each can be reached —
  heard as the device says it, and looked at every second besides.
*/

/** How often a step that waits looks at its condition, in seconds of the step. */
export const LOOK_EVERY_SECONDS = 1;
/** What devices said while one run ran: at most this many readings kept, so a run left waiting long cannot fill the disk. */
export const READINGS_PER_RUN = 20_000;

/** What a run's log reads, and where it is kept: the parts, the runs, what devices say, and the clock. */
export type ListenDeps = Pick<AutomationEngineDeps, 'device' | 'bus'> & { store: Pick<AutomationStorage, 'recordLog' | 'get'>; clock: Clock };

/**
 * Keeps the run's log (docs/SEQUENCES.md): the devices and roles it uses as
 * it begins; then every reading of each device each time its value or time
 * changes — what the value is, the first time one is seen — and whether
 * each can be reached, each time that changes. Heard as each device says
 * it, on the live bus: a reading a step acts on is in the log at the moment
 * it came, not at the next look. Looked at every second as well, and once
 * more as it ends — for a reading said again at a new time, and a device
 * that does not say. Returns what ends it.
 */
export function listen(live: LiveRun, deps: ListenDeps, order: () => number): { look: () => void; stop: () => void } {
  const devices = new Map<string, EngineDevice>();
  const roles: RunLogRole[] = [];
  // In the rule's order of its roles: what it uses first, first.
  for (const role of Object.keys(live.rule.roles)) {
    const binding = live.automation.roles[role];
    const device = binding ? deps.device(binding) : null;
    if (!binding) continue;
    if (!device) continue;
    if (!devices.has(binding.device)) devices.set(binding.device, device);
    roles.push({ role, label: live.rule.roles[role]?.label ?? role, device: binding.device, part: binding.part });
  }
  const keep = (log: Parameters<AutomationStorage['recordLog']>[1]) => {
    try {
      deps.store.recordLog(live.id, log);
    } catch (error) {
      // Its automation deleted while it ran: its run, and its log, are gone with it — that, and only that, is expected.
      if (live.gone || !deps.store.get(live.automation.id)) return;
      console.error(`[automations] the log of a run of "${live.automation.name}" could not be kept: ${(error as Error).message}`);
    }
  };
  keep({ devices: [...devices].map(([id, device]) => ({ id, name: device.deviceName, typeId: device.typeId })), roles });

  const described = new Set<string>();
  const last = new Map<string, string>();
  let kept = 0;
  /** What one device says now — some of its readings, or all — and whether it can be reached: what is new of it, kept. */
  const hear = (id: string, device: EngineDevice, readings: readonly Reading[], reachable: { reachable: boolean; detail: string } | null) => {
    const heardAt = new Date(deps.clock.now()).toISOString();
    const log: { keys: RunLogKey[]; readings: RunLogReading[]; reach: RunLogReach[] } = { keys: [], readings: [], reach: [] };
    if (reachable) {
      const said = `${reachable.reachable} ${reachable.detail}`;
      if (last.get(id) !== said) {
        last.set(id, said);
        log.reach.push({ device: id, at: heardAt, reachable: reachable.reachable, detail: reachable.detail });
      }
    }
    for (const reading of readings) {
      const mark = `${reading.at} ${JSON.stringify(reading.value)}`;
      const which = `${id} ${reading.key}`;
      if (last.get(which) === mark) continue;
      last.set(which, mark);
      // Heard now, in the order of what happens here: what a wait judges by, whatever the device stamped.
      live.heard.set(which, order());
      if (kept >= READINGS_PER_RUN) continue;
      if (!described.has(which)) {
        described.add(which);
        log.keys.push(logKeyOf(id, reading.key, device.description));
      }
      kept += 1;
      log.readings.push({ device: id, key: reading.key, at: reading.at, heardAt, value: reading.value });
    }
    keep(log);
  };
  const look = () => {
    for (const [id, device] of devices) hear(id, device, device.device?.readings() ?? [], device.reachable());
  };
  look();
  // As each device says it.
  const unsubscribe = deps.bus?.subscribe((message) => {
    if (message.kind !== 'readings' && message.kind !== 'health') return;
    const device = devices.get(message.deviceId);
    if (!device) return;
    if (message.kind === 'readings') hear(message.deviceId, device, message.readings, null);
    else hear(message.deviceId, device, [], device.reachable());
  });
  const timer = deps.clock.setInterval(look, LOOK_EVERY_SECONDS * 1000);
  return {
    look,
    stop: () => {
      deps.clock.clear(timer);
      unsubscribe?.();
      look();
    },
  };
}

/**
 * A value a run's log keeps, as its device describes it: its part and label
 * — "AC outlets: Power" for a part's — and its kind, unit, quantity and words.
 * A key the description does not name is text, called by its key.
 */
export function logKeyOf(device: string, key: string, description: DeviceDescription): RunLogKey {
  const attribute = description.attributes.find((candidate) => candidate.key === key);
  if (!attribute) return { device, key, part: MAIN_PART, label: key, kind: 'text', unit: null, quantity: null, words: null, options: null };
  const part = attribute.part ?? MAIN_PART;
  const partLabel = part === MAIN_PART ? null : (description.parts ?? []).find((each) => each.id === part)?.label;
  // Its part named once: "AC outlets draw" says its part already, "Power" does not.
  const label = partLabel && !attribute.label.toLowerCase().startsWith(partLabel.toLowerCase()) ? `${partLabel}: ${attribute.label}` : attribute.label;
  const type = attribute.value;
  if (type.type === 'number') return { device, key, part, label, kind: 'number', unit: unitOf(attribute) || null, quantity: quantityOf(attribute), words: null, options: null };
  if (type.type === 'boolean') return { device, key, part, label, kind: 'boolean', unit: null, quantity: null, words: type.words ?? null, options: null };
  if (type.type === 'enum') return { device, key, part, label, kind: 'enum', unit: null, quantity: null, words: null, options: [...type.options] };
  return { device, key, part, label, kind: 'text', unit: null, quantity: null, words: null, options: null };
}
