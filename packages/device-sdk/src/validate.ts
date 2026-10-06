import { CATEGORIES, isCategory } from './categories.ts';
import { validateDescription } from './check-description.ts';
import { BRIDGE_TRANSPORT } from './bridge.ts';
import { isBridgedMethod, REACHES, SIMULATED_METHOD_ID, SIMULATED_TRANSPORT } from './connection.ts';
import { DEVICE_KINDS, type DeviceType } from './device-type.ts';
import { CAMEL_NAME, NAMESPACED_ID, PLAIN_ID } from './names.ts';
import { NODE_TRAITS, PLATFORMS } from './node.ts';
import type { Protocol } from './protocol.ts';
import { configDefaults, isSecretField, schemaProblems, type ConfigSchema } from './schema.ts';
import type { TransportDefinition } from './transport.ts';
import { valueTypeProblems } from './values.ts';

/** The shared vocabulary's namespace — its recipes are `standard.…` — which no device type may take. */
export const STANDARD_NAMESPACE = 'standard';

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



const secretsIn = (schema: ConfigSchema | undefined): string[] =>
  Object.entries(schema?.fields ?? {})
    .filter(([, field]) => isSecretField(field))
    .map(([name]) => name);

export function validateDeviceType(type: DeviceType<any>): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);

  // --- identity ---------------------------------------------------------------
  if (!NAMESPACED_ID.test(type.id ?? '')) problem(`id "${type.id}" must be namespaced lowercase, like "brand.model"`);
  else if (type.id.split('.')[0] === STANDARD_NAMESPACE) problem(`id "${type.id}" is in the namespace "${STANDARD_NAMESPACE}", which is the shared vocabulary's`);
  if (!DEVICE_KINDS.includes(type.kind)) problem(`kind must be one of: ${DEVICE_KINDS.join(', ')}`);
  if (type.bridge?.fallback !== undefined && !NAMESPACED_ID.test(type.bridge.fallback)) problem(`bridge.fallback "${type.bridge.fallback}" must be a type's id`);

  const meta = type.meta ?? ({} as DeviceType['meta']);
  if (!meta.name?.trim()) problem('meta.name is required');
  if (!isCategory(meta.category ?? '')) problem(`meta.category "${meta.category}" is not one of: ${Object.keys(CATEGORIES).join(', ')}`);
  if (!meta.icon?.trim()) problem('meta.icon is required');
  if (!['verified', 'community', 'experimental'].includes(meta.support)) {
    problem('meta.support must be verified, community or experimental');
  }

  // --- config ---------------------------------------------------------------
  if (!type.config?.fields) problem('config is required, even when it has no fields');
  problems.push(...schemaProblems('config', type.config));
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
    if (method.id === SIMULATED_METHOD_ID) problem(`connection method id "${SIMULATED_METHOD_ID}" is every type's own: its simulator`);
    methodIds.add(method.id);
    if (!method.label?.trim()) problem(`connection method "${method.id}" has no label`);
    if (isBridgedMethod(method)) {
      // Through a bridge: the bridge types it goes through, and nothing of a transport's.
      if (!method.through.length) problem(`connection method "${method.id}" goes through a bridge without naming which: "through" lists the bridge types`);
      for (const bridge of method.through) if (!NAMESPACED_ID.test(bridge)) problem(`connection method "${method.id}" goes through "${bridge}", which is not a type's id`);
      const raw = method as unknown as Record<string, unknown>;
      for (const key of ['protocol', 'transport', 'address', 'platforms']) {
        if (raw[key] !== undefined) problem(`connection method "${method.id}" goes through a bridge, so it has no ${key} of its own: it reads its bridge through a link`);
      }
    } else {
      if (method.transport === SIMULATED_TRANSPORT) problem(`connection method "${method.id}" goes over "${SIMULATED_TRANSPORT}", which only the simulated method may`);
      if (method.transport === BRIDGE_TRANSPORT) problem(`connection method "${method.id}" goes over "${BRIDGE_TRANSPORT}": a way through a bridge names it in "through", with no transport`);
      for (const platform of method.platforms ?? []) if (!(PLATFORMS as readonly string[]).includes(platform)) problem(`connection method "${method.id}" is held on "${platform}", which is not a platform: ${PLATFORMS.join(', ')}`);
      if (method.platforms && !method.platforms.length) problem(`connection method "${method.id}" can be held nowhere: its platforms are empty`);
      if (!method.protocol?.trim()) problem(`connection method "${method.id}" names no protocol`);
      if (!method.transport?.trim()) problem(`connection method "${method.id}" names no transport`);
    }
    if (!REACHES.includes(method.reach)) problem(`connection method "${method.id}" must say what it reaches: ${REACHES.join(', ')}`);
    for (const [trait, why] of Object.entries(method.needs ?? {})) {
      if (!(NODE_TRAITS as readonly string[]).includes(trait)) problem(`connection method "${method.id}" needs "${trait}" of a node, which no node declares: ${NODE_TRAITS.join(', ')}`);
      else if (typeof why !== 'string' || !why.trim()) problem(`connection method "${method.id}" needs "${trait}" of a node without saying why`);
    }
    problems.push(...schemaProblems(`connection method "${method.id}" config`, method.config));
    for (const field of secretsIn(method.config)) {
      problem(`connection method "${method.id}": "${field}" is a secret; secrets are the protocol's credentials`);
    }
  }
  if (methods.filter((method) => method.recommended).length > 1) problem('more than one connection method is recommended');

  // --- tools ------------------------------------------------------------------
  for (const [name, tool] of Object.entries(type.tools ?? {})) {
    const where = `tool "${name}"`;
    if (!CAMEL_NAME.test(name)) problem(`${where} is named in camelCase`);
    if (!tool.label?.trim() || !tool.description?.trim()) problem(`${where} needs a label and a description`);
    problems.push(...valueTypeProblems(`${where} answer`, tool.answer));
    problems.push(...schemaProblems(`${where} input`, tool.input));
    if (secretsIn(tool.input).length) problem(`${where} asks for a secret; a tool's input is audited`);
    if (tool.honoursReadOnly && !tool.writes) problem(`${where} honours read-only mode but never writes`);
  }

  // --- setup steps ------------------------------------------------------------
  const stepIds = new Set<string>(['ready', 'choose', 'credentials', 'connection', 'check']);
  const steps = [...(type.setup?.steps ?? []), ...methods.flatMap((method) => method.steps ?? [])];
  for (const step of steps) {
    if (stepIds.has(step.id)) problem(`setup step "${step.id}" is declared twice, or uses a name the core reserves`);
    stepIds.add(step.id);
    if (step.kind === 'form') problems.push(...schemaProblems(`setup step "${step.id}"`, step.schema));
    if (step.kind === 'form' && step.target === 'device') {
      for (const field of Object.keys(step.schema.fields)) {
        if (!(field in (type.config?.fields ?? {}))) problem(`setup step "${step.id}" asks for "${field}", which is not in config`);
      }
    }
  }

  if (typeof type.describe !== 'function') problem('describe is missing');
  else {
    try {
      problems.push(...validateDescription(type.describe(configDefaults(type.config)), type.id));
    } catch (error) {
      problem(`describe() failed with the default config: ${(error as Error).message}`);
    }
  }
  if (typeof type.identify !== 'function') problem('identify is missing');
  if (typeof type.createSession !== 'function') problem('createSession is missing');
  if (typeof type.createSimulator !== 'function') problem('createSimulator is missing');

  return problems;
}

export function validateTransportDefinition(transport: TransportDefinition): string[] {
  const problems: string[] = [];
  if (!PLAIN_ID.test(transport.id ?? '')) problems.push(`transport id "${transport.id}" must be lowercase words`);
  if (transport.id === SIMULATED_TRANSPORT) problems.push(`transport id "${SIMULATED_TRANSPORT}" is taken: it means simulated`);
  if (!transport.label?.trim()) problems.push(`transport "${transport.id}" has no label`);
  if (!['bytes', 'messages', 'http'].includes(transport.channel)) problems.push(`transport "${transport.id}" has an unknown channel "${transport.channel}"`);
  if (typeof transport.nearby !== 'boolean') problems.push(`transport "${transport.id}" does not say whether it reaches only what is near its holder (nearby)`);
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
  installed: { protocol(id: string): Protocol | null; transport(id: string): TransportDefinition | null; type?(id: string): DeviceType<any> | null }
): string[] {
  const problems: string[] = [];
  for (const method of type.connections ?? []) {
    // Through a bridge: no protocol and no transport; what it goes through must be an installed bridge.
    if (isBridgedMethod(method)) {
      for (const id of method.through) {
        const bridge = installed.type?.(id);
        if (installed.type && !bridge) problems.push(`connection method "${method.id}" goes through "${id}", which is not installed`);
        else if (bridge && !bridge.bridge) problems.push(`connection method "${method.id}" goes through "${id}", which is not a bridge`);
      }
      continue;
    }
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
