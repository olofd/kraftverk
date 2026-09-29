import { CAPABILITIES, isCapability, requiredMeanings } from './capabilities.ts';
import { CATEGORIES, isCategory } from './categories.ts';
import { PLATFORMS, type Protocol, type TransportDefinition } from './connection.ts';
import { validateDescription } from './description.ts';
import { DEVICE_MODEL_VERSION, type DeviceTypeV4 } from './device-model.ts';
import { DEVICE_API_VERSION, type DeviceType } from './device-type.ts';
import { isSecretField, type ConfigSchema, type ConfigValues } from './schema.ts';
import { STANDARD_NAMESPACES, STATE_CLASSES, standardMetric, stateClassOf } from './telemetry.ts';

/**
 * The static half of the contract: everything about a device type, a protocol
 * or a transport that can be checked without running it.
 *
 * The server runs these on every package it discovers and refuses one that
 * fails, saying why, so a broken package is a line in the log rather than a
 * device that half works. The contract suite (`@kraftverk/device-sdk/testing`)
 * runs them too, and then the other half, against the type's simulator.
 *
 * Each returns every problem, not the first: a contributor should see the
 * whole list.
 */

const NAMESPACED_ID = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const PLAIN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const secretsIn = (schema: ConfigSchema | undefined): string[] =>
  Object.entries(schema?.fields ?? {})
    .filter(([, field]) => isSecretField(field))
    .map(([name]) => name);

/** What every device type is checked for, whatever version of the contract it keeps. */
type AnyDeviceType = Pick<DeviceType<any>, 'id' | 'kind' | 'meta' | 'config' | 'connections' | 'setup'> & {
  identify?: unknown;
  createSession?: unknown;
  createSimulator?: unknown;
};

function commonTypeProblems(type: AnyDeviceType): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);

  // --- identity ---------------------------------------------------------------
  if (!NAMESPACED_ID.test(type.id ?? '')) problem(`id "${type.id}" must be namespaced lowercase, like "brand.model"`);
  if (type.kind !== 'hardware' && type.kind !== 'service') problem(`kind must be "hardware" or "service"`);

  const meta = type.meta ?? ({} as DeviceType['meta']);
  if (!meta.name?.trim()) problem('meta.name is required');
  if (!isCategory(meta.category ?? '')) {
    problem(`meta.category "${meta.category}" is not one of: ${Object.keys(CATEGORIES).join(', ')}`);
  } else {
    const section = CATEGORIES[meta.category].section;
    if ((section === 'services') !== (type.kind === 'service')) {
      problem(`meta.category "${meta.category}" lists ${section}, but the type is ${type.kind}`);
    }
  }
  if (!meta.icon?.trim()) problem('meta.icon is required');
  if (!['verified', 'community', 'experimental'].includes(meta.support)) {
    problem('meta.support must be verified, community or experimental');
  }

  // --- config ---------------------------------------------------------------
  if (!type.config?.fields) problem('config is required, even when it has no fields');
  for (const field of secretsIn(type.config)) {
    problem(`config field "${field}" is a secret; secrets belong to a connection's credentials`);
  }

  // --- connection methods -----------------------------------------------------
  const methods = type.connections ?? [];
  if (!methods.length) problem('a device type needs at least one connection method');
  const methodIds = new Set<string>();
  for (const method of methods) {
    if (!PLAIN_ID.test(method.id ?? '')) problem(`connection method id "${method.id}" must be lowercase words`);
    if (methodIds.has(method.id)) problem(`connection method "${method.id}" is declared twice`);
    methodIds.add(method.id);
    if (!method.label?.trim()) problem(`connection method "${method.id}" has no label`);
    if (!method.protocol?.trim()) problem(`connection method "${method.id}" names no protocol`);
    if (!method.transport?.trim()) problem(`connection method "${method.id}" names no transport`);
    for (const field of secretsIn(method.config)) {
      problem(`connection method "${method.id}": "${field}" is a secret; secrets are the protocol's credentials`);
    }
  }
  if (methods.filter((method) => method.recommended).length > 1) problem('more than one connection method is recommended');

  // --- setup steps ------------------------------------------------------------
  const stepIds = new Set<string>(['ready', 'choose', 'credentials', 'connection', 'check']);
  const steps = [...(type.setup?.steps ?? []), ...methods.flatMap((method) => method.steps ?? [])];
  for (const step of steps) {
    if (stepIds.has(step.id)) problem(`setup step "${step.id}" is declared twice, or uses a name the core reserves`);
    stepIds.add(step.id);
    if (step.kind === 'form' && step.target === 'device') {
      for (const field of Object.keys(step.schema.fields)) {
        if (!(field in (type.config?.fields ?? {}))) problem(`setup step "${step.id}" asks for "${field}", which is not in config`);
      }
    }
  }

  if (typeof type.identify !== 'function') problem('identify is missing');
  if (typeof type.createSession !== 'function') problem('createSession is missing');
  if (typeof type.createSimulator !== 'function') problem('createSimulator is missing');

  return problems;
}

export function validateDeviceType(type: DeviceType<any>): string[] {
  const problems = commonTypeProblems(type);
  const problem = (message: string) => problems.push(message);
  if (type.apiVersion !== DEVICE_API_VERSION) {
    problem(`apiVersion is "${type.apiVersion}"; this SDK speaks "${DEVICE_API_VERSION}"`);
  }

  // --- capabilities -----------------------------------------------------------
  const capabilities = new Set<string>();
  for (const name of type.capabilities ?? []) {
    if (!isCapability(name)) problem(`capability "${name}" is not in the library`);
    if (capabilities.has(name)) problem(`capability "${name}" is declared twice`);
    capabilities.add(name);
  }

  // --- telemetry --------------------------------------------------------------
  const keys = new Set<string>();
  const metrics = new Set<string>();
  let primaries = 0;
  for (const spec of type.telemetry ?? []) {
    if (!spec.key?.trim()) problem('a telemetry entry has no key');
    if (keys.has(spec.key)) problem(`telemetry key "${spec.key}" is declared twice`);
    keys.add(spec.key);
    if (spec.primary) primaries += 1;
    if (spec.stateClass !== undefined) {
      if (!STATE_CLASSES.includes(spec.stateClass)) problem(`"${spec.key}" has an unknown state class "${spec.stateClass}"`);
      else if (spec.kind === 'state') problem(`"${spec.key}" is an on/off state, which has no state class`);
    }

    if (spec.metric === undefined) continue;
    if (metrics.has(spec.metric)) problem(`metric "${spec.metric}" is claimed by two keys`);
    metrics.add(spec.metric);

    const standard = standardMetric(spec.metric);
    if (standard) {
      // Two devices' values on one axis without conversion is the point.
      if (standard.kind !== spec.kind || standard.unit !== spec.unit) {
        problem(
          `"${spec.key}" claims ${spec.metric}, which is ${standard.kind} in "${standard.unit}", ` +
            `but is declared ${spec.kind} in "${spec.unit}"`
        );
      }
      // A lifetime counter charted as a level, or a level charted as a counter, is a wrong chart.
      if ((standard.stateClass ?? 'measurement') !== (stateClassOf(spec) ?? 'measurement')) {
        problem(`"${spec.key}" claims ${spec.metric}, which is ${standard.stateClass ?? 'measurement'}, but is declared ${stateClassOf(spec) ?? 'measurement'}`);
      }
    } else {
      const namespace = spec.metric.split('.')[0]!;
      if (!spec.metric.includes('.') || STANDARD_NAMESPACES.includes(namespace)) {
        problem(
          `metric "${spec.metric}" on "${spec.key}" is not a standard id; a type's own metrics ` +
            `are namespaced by the type, like "${type.id?.split('.').pop() ?? 'brand'}.${spec.key}"`
        );
      }
    }
  }
  if (primaries > 1) problem('more than one telemetry entry is marked primary');

  for (const name of capabilities) {
    if (!isCapability(name)) continue;
    for (const required of requiredMeanings(name)) {
      if (!metrics.has(required)) problem(`capability "${name}" needs telemetry with metric "${required}"`);
    }
  }

  // --- controls ---------------------------------------------------------------
  const controls = new Set<string>();
  for (const control of type.controls ?? []) {
    if (controls.has(control.id)) problem(`control "${control.id}" is declared twice`);
    controls.add(control.id);
    if (!capabilities.has(control.capability)) {
      problem(`control "${control.id}" uses "${control.capability}", which the type does not declare`);
      continue;
    }
    const command = control.command ?? 'set';
    const commands = isCapability(control.capability) ? CAPABILITIES[control.capability].commands : {};
    if (!(command in commands)) problem(`control "${control.id}": "${control.capability}" has no command "${command}"`);
    if (control.measurementKey && !keys.has(control.measurementKey)) {
      problem(`control "${control.id}" reads "${control.measurementKey}", which is not in telemetry`);
    }
  }

  // --- settings and config ----------------------------------------------------
  if (type.settings) {
    for (const field of type.settings.dangerous ?? []) {
      if (!(field in type.settings.schema.fields)) problem(`dangerous setting "${field}" is not in the settings schema`);
    }
  }
  return problems;
}

/** The defaults a type's config schema gives, for describing a device before any is saved. */
export const configDefaults = (schema: ConfigSchema): ConfigValues =>
  Object.fromEntries(Object.entries(schema.fields).flatMap(([name, field]) => ('default' in field && field.default !== undefined ? [[name, field.default]] : [])));

/**
 * The static half of the version-4 contract: what every type is checked for,
 * and the description it declares for a device with its default config.
 */
export function validateDeviceTypeV4(type: DeviceTypeV4<any>): string[] {
  const problems = commonTypeProblems(type);
  const problem = (message: string) => problems.push(message);
  if (type.apiVersion !== DEVICE_MODEL_VERSION) problem(`apiVersion is "${type.apiVersion}"; the device model is "${DEVICE_MODEL_VERSION}"`);
  if (!Number.isInteger(type.version) || type.version < 1) problem('version must be a whole number from 1');
  if (type.migrate !== undefined && typeof type.migrate !== 'function') problem('migrate must be a function');
  if (typeof type.describe !== 'function') {
    problem('describe is missing');
    return problems;
  }
  try {
    problems.push(...validateDescription(type.describe(configDefaults(type.config)), type.id));
  } catch (error) {
    problem(`describe() failed with its default config: ${(error as Error).message}`);
  }
  return problems;
}

export function validateTransportDefinition(transport: TransportDefinition): string[] {
  const problems: string[] = [];
  if (!PLAIN_ID.test(transport.id ?? '')) problems.push(`transport id "${transport.id}" must be lowercase words`);
  if (!transport.label?.trim()) problems.push(`transport "${transport.id}" has no label`);
  if (!['bytes', 'messages', 'http'].includes(transport.channel)) problems.push(`transport "${transport.id}" has an unknown channel "${transport.channel}"`);
  if (!transport.platforms?.length) problems.push(`transport "${transport.id}" runs nowhere`);
  for (const platform of transport.platforms ?? []) {
    if (!PLATFORMS.includes(platform)) problems.push(`transport "${transport.id}" names an unknown platform "${platform}"`);
  }
  return problems;
}

export function validateProtocol(protocol: Protocol): string[] {
  const problems: string[] = [];
  if (!PLAIN_ID.test(protocol.id ?? '')) problems.push(`protocol id "${protocol.id}" must be lowercase words`);
  if (!protocol.label?.trim()) problems.push(`protocol "${protocol.id}" has no label`);
  if (!Object.keys(protocol.bindings ?? {}).length) problems.push(`protocol "${protocol.id}" has no binding to any transport`);
  for (const [transport, binding] of Object.entries(protocol.bindings ?? {})) {
    if (typeof binding.open !== 'function') problems.push(`protocol "${protocol.id}": its ${transport} binding cannot open`);
    if (typeof binding.recognise !== 'function') problems.push(`protocol "${protocol.id}": its ${transport} binding cannot recognise`);
  }
  return problems;
}

/**
 * What only an installation can check: that every method of a type names a
 * protocol and a transport that are installed, and a protocol that rides that
 * transport.
 */
export function connectionProblems(
  type: DeviceType<any>,
  installed: { protocol(id: string): Protocol | null; transport(id: string): TransportDefinition | null }
): string[] {
  const problems: string[] = [];
  for (const method of type.connections ?? []) {
    const protocol = installed.protocol(method.protocol);
    const transport = installed.transport(method.transport);
    if (!protocol) problems.push(`connection method "${method.id}" speaks "${method.protocol}", which is not installed`);
    if (!transport) problems.push(`connection method "${method.id}" goes over "${method.transport}", which is not installed`);
    if (protocol && transport && !protocol.bindings[transport.id]) {
      problems.push(`connection method "${method.id}": "${protocol.id}" has no binding for "${transport.id}"`);
    }
    if (method.address && transport?.channel !== 'http') {
      problems.push(`connection method "${method.id}" has a fixed address, which only a web API may`);
    }
  }
  return problems;
}
