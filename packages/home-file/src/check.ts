import { isTimeZone, MAIN_PART, validateConfig, type ConfigSchema } from '@kraftverk/device-sdk';

import type { ConfigDocument, DeviceEntry, SecretValue } from './document.ts';
import type { Issue } from '@kraftverk/automation';
import type { Vocabulary } from './vocabulary.ts';

/*
  What a configuration means, checked (docs/CONFIG.md): beyond its shape,
  that each device's type is installed and each way to reach it is one of the
  type's, that its settings are what the type and the method accept, that the
  secrets a way needs are there, and that every link and every automation
  names devices, parts and automations that exist — in the file, or on the
  server. Pure, on the vocabulary: the app runs it as the server does.
*/

export type CheckOptions = {
  /**
   * Whether a secret named `!secret name` is known, when the document's own
   * `secrets` does not have it: a secrets file kept beside it, or the
   * server's. Unknown by default.
   */
  hasSecret?: (name: string) => boolean;
  /**
   * Whether the devices an automation's roles name are checked here: an
   * import leaves them to itself, and asks for one you have where a file
   * names one you do not.
   */
  uses?: 'check' | 'leave';
};

type Path = (string | number)[];

/** Every problem with what a document means, with its path. Empty when it means nothing wrong. */
export function checkDocument(document: ConfigDocument, vocabulary: Vocabulary, options: CheckOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const problem = (message: string, path: Path) => void issues.push({ message, path });
  const types = new Map(vocabulary.types.map((type) => [type.id, type]));

  // The settings a schema accepts: each field it has, valid — and none it has not.
  const settings = (schema: ConfigSchema, values: Record<string, unknown>, path: Path, what: string) => {
    for (const name of Object.keys(values)) if (!(name in schema.fields)) problem(`${what} has no setting "${name}"${Object.keys(schema.fields).length ? `: it has ${Object.keys(schema.fields).join(', ')}` : ''}`, [...path, name]);
    const known = Object.fromEntries(Object.entries(values).filter(([name]) => name in schema.fields));
    const valid = validateConfig(schema, known);
    if (!valid.ok) for (const issue of valid.issues) problem(issue.message, issue.field in values ? [...path, issue.field] : path);
  };

  // The home.
  if (document.home.clock !== null && !isTimeZone(document.home.clock)) problem(`"${document.home.clock}" is not a time zone: "Europe/Stockholm"`, ['home', 'clock']);
  for (const [name, value] of Object.entries(document.home.policy)) {
    const spec = vocabulary.policy[name];
    if (!spec) problem(`"${name}" is not one of the home's values: ${Object.keys(vocabulary.policy).join(', ')}`, ['home', 'policy', name]);
    else if (value < spec.min || value > spec.max) problem(`${spec.label} is from ${spec.min} to ${spec.max} ${spec.unit}`, ['home', 'policy', name]);
  }

  // Each device.
  for (const [key, device] of Object.entries(document.devices)) {
    const path: Path = ['devices', key];
    const type = types.get(device.type);
    if (!type) {
      problem(`No installed device type is called "${device.type}"`, [...path, 'type']);
      continue;
    }
    settings(type.settings, device.settings, [...path, 'settings'], type.name);
    device.connect.forEach((way, index) => {
      const at: Path = [...path, 'connect', index];
      const method = type.methods.find((each) => each.id === way.via);
      if (!method) {
        problem(`${type.name} is not reached "${way.via}": it is reached ${type.methods.map((each) => `"${each.id}"`).join(', ')}`, [...at, 'via']);
        return;
      }
      if (way.address === null && !method.fixedAddress) problem(`${method.label} needs an address: where it is found`, at);
      settings(method.settings, way.settings, [...at, 'settings'], method.label);
      for (const field of Object.keys(way.secrets)) if (!(field in method.secrets.fields)) problem(`${method.label} keeps no secret "${field}"`, [...at, 'secrets', field]);
      for (const [field, spec] of Object.entries(method.secrets.fields)) {
        const value: SecretValue | undefined = way.secrets[field];
        if (!value) {
          if (spec.required) problem(`${method.label} needs its ${spec.title}: under "secrets", as "${field}"`, at);
          continue;
        }
        if ('secret' in value && !(value.secret in document.secrets) && !options.hasSecret?.(value.secret)) problem(`There is no secret called "${value.secret}": under "secrets", or in the secrets kept beside the file`, [...at, 'secrets', field]);
      }
    });
  }

  // A device by its key — in the file, or one the server has — and whether it has a part.
  const deviceOf = (key: string): { name: string; parts: string[] } | null => {
    const own: DeviceEntry | undefined = document.devices[key];
    if (own) return { name: own.name, parts: types.get(own.type)?.parts ?? [MAIN_PART] };
    const there = vocabulary.devices.find((device) => device.key === key);
    return there ? { name: there.name, parts: there.parts } : null;
  };
  const part = (ref: { device: string; part: string }, path: Path) => {
    const device = deviceOf(ref.device);
    if (!device) problem(`There is no device "${ref.device}", in the file or on the server`, path);
    else if (ref.part !== MAIN_PART && !device.parts.includes(ref.part)) problem(`${device.name} has no part "${ref.part}": it has ${device.parts.join(', ')}`, path);
  };

  // Each link.
  document.links.forEach((link, index) => {
    const path: Path = ['links', index, link.kind];
    if (!vocabulary.linkKinds.includes(link.kind)) problem(`"${link.kind}" is not a kind of link: ${vocabulary.linkKinds.join(', ')}`, ['links', index]);
    part(link.from, [...path, 'from']);
    part(link.to, [...path, 'to']);
    if (link.from.device === link.to.device) problem('A link joins two devices, not one to itself', path);
  });

  // Each automation.
  for (const [key, automation] of Object.entries(document.automations)) {
    const path: Path = ['automations', key];
    if (!isTimeZone(automation.clock)) problem(`"${automation.clock}" is not a time zone: "Europe/Stockholm"`, [...path, 'clock']);
    for (const [role, use] of Object.entries(automation.uses)) {
      if ('device' in use) {
        if (options.uses !== 'leave') part(use, [...path, 'uses', role]);
      }
      else if (!(use.automation in document.automations) && !vocabulary.automations.some((each) => each.key === use.automation)) {
        problem(`There is no automation "${use.automation}", in the file or on the server`, [...path, 'uses', role]);
      }
    }
  }
  return issues;
}
