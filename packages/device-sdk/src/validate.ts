import { CAPABILITIES, isCapability } from './capabilities.ts';
import { DEVICE_API_VERSION, type DeviceType } from './device-type.ts';
import { STANDARD_NAMESPACES, standardMetric } from './telemetry.ts';

/**
 * The static half of the contract: everything about a device type that can be
 * checked without running it.
 *
 * The server runs this on every type it discovers and refuses one that fails,
 * saying why, so a broken package is a line in the log rather than a device
 * that half works. The contract suite (`@kraftverk/device-sdk/testing`) runs it
 * too, and then the other half, against the type's simulator.
 *
 * Returns every problem, not the first: a contributor should see the whole list.
 */
export function validateDeviceType(type: DeviceType<any>): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);

  // --- identity ---------------------------------------------------------------
  if (!/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/.test(type.id ?? '')) {
    problem(`id "${type.id}" must be namespaced lowercase, like "brand.model"`);
  }
  if (type.apiVersion !== DEVICE_API_VERSION) {
    problem(`apiVersion is "${type.apiVersion}"; this SDK speaks "${DEVICE_API_VERSION}"`);
  }
  if (type.kind !== 'hardware' && type.kind !== 'service') problem(`kind must be "hardware" or "service"`);

  const meta = type.meta ?? ({} as DeviceType['meta']);
  if (!meta.name?.trim()) problem('meta.name is required');
  if (!meta.category?.trim()) problem('meta.category is required');
  if (!meta.icon?.trim()) problem('meta.icon is required');
  if (!['verified', 'community', 'experimental'].includes(meta.support)) {
    problem('meta.support must be verified, community or experimental');
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
    for (const required of CAPABILITIES[name].requires) {
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
  if (!type.config?.fields) problem('config is required, even when it has no fields');

  // --- the setup guide --------------------------------------------------------
  const steps = type.setup?.steps ?? [];
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) problem(`setup step "${step.id}" is declared twice`);
    stepIds.add(step.id);
    if (step.kind === 'form') {
      for (const field of step.fields) {
        if (!type.config?.fields || !(field in type.config.fields)) {
          problem(`setup step "${step.id}" asks for "${field}", which is not in config`);
        }
      }
    }
  }
  // A device is saved once it has worked, so every guide has to be able to show that.
  if (!steps.some((step) => step.kind === 'verify')) problem('the setup guide has no verify step');

  if (typeof type.createSession !== 'function') problem('createSession is missing');
  if (typeof type.createSimulator !== 'function') problem('createSimulator is missing');

  return problems;
}
