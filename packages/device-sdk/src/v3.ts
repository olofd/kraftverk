import type {
  CommandResult,
  OutletsCapability,
  SwitchCapability,
  WeatherForecastCapability,
} from './capabilities.ts';
import { MAIN_PART, type AttributeReading, type AttributeSpec, type DeviceDescription, type Part } from './description.ts';
import { DEVICE_MODEL_VERSION, type DeviceSessionV4, type DeviceTypeV4 } from './device-model.ts';
import type { DeviceSession, DeviceType } from './device-type.ts';
import { valueTypeOf, type ConfigValues } from './schema.ts';

/**
 * A version-3 device type, seen as a version-4 one (docs/ARCHITECTURE.md §8
 * step 24).
 *
 * So that every holder can speak the new model before any package is
 * rewritten. What version 3 said with names, version 4 says with structure:
 * an outlet that was the metric pattern `outlet.<id>.on` is a part of its own
 * offering `switch`; a setting in the settings schema is an attribute that can
 * be written; a command to `outlets` is a command to the outlet's `switch`.
 * Nothing about the device changes — keys, and so history, stay as they were.
 */

const OUTLET_METRIC = /^outlet\.([a-z0-9-]+)\.(on|power)$/;
const OUTLET_PART = /^outlet\.([a-z0-9-]+)$/;

const refuse = (error: string): CommandResult => ({ accepted: false, error });

/** The description a version-3 type's declarations amount to. */
export function describeV3(type: DeviceType<any>): DeviceDescription {
  const controls = type.controls ?? [];
  const outletParts = new Map<string, Part>();
  const attributes: AttributeSpec[] = [];

  for (const spec of type.telemetry) {
    const outlet = spec.metric ? OUTLET_METRIC.exec(spec.metric) : null;
    const part = outlet ? `outlet.${outlet[1]}` : MAIN_PART;
    if (outlet && !outletParts.has(part)) {
      const control = controls.find((candidate) => candidate.capability === 'outlets' && candidate.target === outlet[1]);
      outletParts.set(part, {
        id: part,
        label: control?.label ?? spec.label,
        kind: 'outlet',
        role: 'load',
        ...(type.capabilities.includes('outlets') ? { offers: ['switch'] as const } : {}),
      });
    }
    const control = controls.find((candidate) => candidate.measurementKey === spec.key);
    const means = outlet ? (outlet[2] === 'on' ? 'switch.on' : 'power.draw') : spec.metric;
    attributes.push({
      key: spec.key,
      ...(part !== MAIN_PART ? { part } : {}),
      label: spec.label,
      value: spec.kind === 'state' ? { type: 'boolean' } : { type: 'number', unit: spec.unit, ...(spec.precision !== undefined ? { precision: spec.precision } : {}) },
      ...(spec.kind !== 'state' ? { quantity: spec.kind } : {}),
      ...(means ? { means } : {}),
      ...(spec.stateClass ? { stateClass: spec.stateClass } : {}),
      ...(spec.primary ? { category: 'primary' as const } : {}),
      ...(control?.consequence ? { consequence: control.consequence } : {}),
    });
  }

  const dangerous = new Set(type.settings?.dangerous ?? []);
  for (const [field, spec] of Object.entries(type.settings?.schema.fields ?? {})) {
    attributes.push({
      key: field,
      label: spec.title,
      ...(spec.description ? { description: spec.description } : {}),
      value: valueTypeOf(spec),
      access: 'write',
      category: 'config',
      ...(dangerous.has(field) ? { dangerous: true } : {}),
    });
  }

  const main: Part = { id: MAIN_PART, label: type.meta.name, kind: 'device', offers: type.capabilities.filter((name) => name !== 'outlets') };
  return { parts: [main, ...outletParts.values()], attributes, events: [] };
}

/** The newest time any reading was produced, for settings, which carry none of their own. */
const newest = (readings: readonly { at: string }[]): string =>
  readings.reduce<string | null>((latest, reading) => (latest === null || reading.at > latest ? reading.at : latest), null) ?? new Date().toISOString();

/** A version-3 session, answering version-4 requests. */
export function upgradeSession(session: DeviceSession, type: DeviceType<any>): DeviceSessionV4 {
  const settingKeys = Object.keys(type.settings?.schema.fields ?? {});
  const upgraded: DeviceSessionV4 = {
    health: () => session.health(),
    readings() {
      const readings: AttributeReading[] = session.readings().map((reading) => ({ key: reading.key, value: reading.value, at: reading.at }));
      const settings = session.readSettings?.() ?? null;
      if (settings) {
        const at = newest(readings);
        for (const key of settingKeys) {
          const value = settings[key];
          if (value !== undefined) readings.push({ key, value, at });
        }
      }
      return readings;
    },
    description: () => null,
    info: () => null,
    async command(request) {
      if (request.capability !== 'switch' || request.command !== 'set') {
        return refuse(`${request.part} takes no ${request.capability}.${request.command}`);
      }
      const on = request.args.on;
      if (typeof on !== 'boolean') return refuse('on must be true or false');
      if (request.part === MAIN_PART) {
        const relay = session.capability('switch') as SwitchCapability | null;
        return relay ? relay.set(on) : refuse('It has no switch');
      }
      const outlet = OUTLET_PART.exec(request.part);
      const outlets = session.capability('outlets') as OutletsCapability | null;
      return outlet && outlets ? outlets.set(outlet[1]!, on) : refuse(`It has no part "${request.part}" that switches`);
    },
    async query(request) {
      const forecast = session.capability('weather.forecast') as WeatherForecastCapability | null;
      if (request.capability === 'weather.forecast' && request.query === 'hourly' && forecast) {
        const hours = typeof request.args.hours === 'number' ? request.args.hours : 24;
        return forecast.hourly(hours);
      }
      throw new Error(`${request.part} answers no ${request.capability}.${request.query}`);
    },
    close: () => session.close(),
  };
  if (session.writeSettings) {
    const write = session.writeSettings.bind(session);
    upgraded.write = async (patch) => {
      const after = await write(patch as ConfigValues);
      // A setting the device did not report is unknown, which the model says with null.
      return after && Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value ?? null]));
    };
  }
  if (session.identity) upgraded.identity = session.identity.bind(session);
  if (session.advanced) (upgraded as { advanced?: DeviceSession['advanced'] }).advanced = session.advanced;
  return upgraded;
}

/** A version-3 type as a version-4 one, at version 1 of its own. */
export function upgradeDeviceType<Config extends ConfigValues>(type: DeviceType<Config>): DeviceTypeV4<Config> {
  const description = describeV3(type);
  return {
    id: type.id,
    apiVersion: DEVICE_MODEL_VERSION,
    version: 1,
    kind: type.kind,
    meta: type.meta,
    config: type.config,
    connections: type.connections,
    ...(type.setup ? { setup: type.setup } : {}),
    describe: () => description,
    async identify(connection, ctx) {
      const found = await type.identify(connection, ctx);
      return found.model ? { ...found, info: { model: found.model } } : found;
    },
    createSession: async (ctx) => upgradeSession(await type.createSession(ctx), type),
    createSimulator: async (ctx) => upgradeSession(await type.createSimulator(ctx), type),
  };
}

export const isDeviceTypeV4 = (type: DeviceType<any> | DeviceTypeV4<any>): type is DeviceTypeV4<any> => type.apiVersion === DEVICE_MODEL_VERSION;

/** Any installed type, as version 4. */
export const asDeviceTypeV4 = <Config extends ConfigValues>(type: DeviceType<Config> | DeviceTypeV4<Config>): DeviceTypeV4<Config> =>
  isDeviceTypeV4(type) ? type : upgradeDeviceType(type as DeviceType<Config>);
