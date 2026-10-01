import { isNode, isScalar, LineCounter, parseDocument, Document, Scalar, type Node, type ScalarTag } from 'yaml';

import { documentFromData, documentToData, emptyDocument, SecretRef, type AutomationEntry, type ConfigDocument, type DeviceEntry, type WriteContext } from './document.ts';
import type { PrintContext } from './expr.ts';
import { CURRENT_VERSION, migrate } from './migrate.ts';
import type { Issue } from './rules.ts';

/*
  A configuration as YAML text, both ways (docs/CONFIG.md): read with every
  problem placed at its line and column — the YAML's own, the document's, and
  inside an expression how far into it — and written back in the order a
  person reads, `!secret name` for a secret kept by name. A whole document, or
  one entry of it: an automation's or a device's own YAML, as its page edits
  it.
*/

/** A problem in a file: what, and where — a path, and its line and column when the text is at hand. */
export type Problem = Issue & { line: number | null; column: number | null };

/** What a document means, checked beyond its shape: problems with their paths, placed in the text by the reader. */
export type Check = (document: ConfigDocument) => Issue[];

export const secretTag: ScalarTag = {
  tag: '!secret',
  identify: (value) => value instanceof SecretRef,
  resolve: (value) => new SecretRef(value),
  stringify: (item) => (item.value as SecretRef).name,
};

/** The schema line editors read: what makes VS Code check the file as it is typed. */
export const schemaLine = (url: string) => `# yaml-language-server: $schema=${url}`;

type Parsed = { data: unknown; problems: Problem[]; place: (issue: Issue) => Problem };

/** YAML text parsed, and a way to place a problem found in its data at its line and column. */
function parseYaml(text: string): Parsed {
  const lines = new LineCounter();
  const parsed = parseDocument(text, { customTags: [secretTag], lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const at = (offset: number) => {
    const position = lines.linePos(offset);
    return { line: position.line, column: position.col };
  };
  const place = (issue: Issue): Problem => {
    const node = issue.path.length ? (parsed.getIn(issue.path, true) as Node | undefined) : parsed.contents;
    // A key with no node of its own (a missing field) is placed at what holds it.
    const holder = !isNode(node) && issue.path.length ? (parsed.getIn(issue.path.slice(0, -1), true) as Node | undefined) : undefined;
    const found = isNode(node) ? node : isNode(holder) ? holder : isNode(parsed.contents) ? parsed.contents : null;
    if (!found?.range) return { ...issue, line: null, column: null };
    let offset = found.range[0];
    if (issue.offset !== undefined && isScalar(found)) {
      // Inside a quoted text, past its opening quote.
      offset += issue.offset + (found.type === 'QUOTE_DOUBLE' || found.type === 'QUOTE_SINGLE' ? 1 : 0);
    }
    return { ...issue, ...at(offset) };
  };
  if (parsed.errors.length) return { data: null, place, problems: parsed.errors.map((error) => ({ message: error.message.split('\n')[0]!, path: [], ...at(error.pos[0]) })) };
  return { data: parsed.toJS({ maxAliasCount: 100 }) as unknown, place, problems: [] };
}

const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null && !Array.isArray(data);

/** A file read: its document, brought to this version — or null — and every problem, placed. */
export function readConfig(text: string, context: PrintContext = {}, check?: Check): { document: ConfigDocument | null; problems: Problem[]; from: number | null } {
  const { data, problems, place } = parseYaml(text);
  if (problems.length) return { document: null, from: null, problems };
  if (!isRecord(data)) return { document: null, from: null, problems: [place({ message: 'A configuration is a map: kraftverk, devices, automations …', path: [] })] };
  const migrated = migrate(data);
  if (!migrated.ok) return { document: null, from: null, problems: [place({ message: migrated.message, path: ['kraftverk'] })] };
  const read = documentFromData(migrated.document, context);
  if (!read.document) return { document: null, from: migrated.from, problems: read.issues.map(place) };
  const meaning = check?.(read.document) ?? [];
  return { document: meaning.length ? null : read.document, from: migrated.from, problems: meaning.map(place) };
}

/**
 * One entry's YAML read — an automation's or a device's own, as its page
 * edits it — as the document it would be part of reads it: the same checks,
 * its problems placed in the entry's own text.
 */
function readEntry<T>(kind: 'automations' | 'devices', text: string, key: string, context: PrintContext, check?: Check, around?: ConfigDocument): { entry: T | null; problems: Problem[] } {
  const { data, problems, place } = parseYaml(text);
  if (problems.length) return { entry: null, problems };
  if (!isRecord(data)) return { entry: null, problems: [place({ message: kind === 'automations' ? 'An automation is a map: name, uses, do …' : 'A device is a map: type, name, connect …', path: [] })] };
  const { [kind]: _theirs, ...rest } = around ? (documentToData(around, context) as Record<string, unknown>) : { kraftverk: CURRENT_VERSION };
  const whole = { ...rest, kraftverk: CURRENT_VERSION, [kind]: { [key]: data } };
  // Its own problems: those under it, placed in its text.
  const own = (issue: Issue): Problem | null =>
    issue.path[0] === kind && issue.path[1] === key ? place({ ...issue, path: issue.path.slice(2) }) : issue.path[0] === 'secrets' ? null : { ...issue, line: null, column: null };
  const read = documentFromData(whole, context);
  if (!read.document) return { entry: null, problems: read.issues.map(own).filter((problem): problem is Problem => problem !== null) };
  const meaning = (check?.(read.document) ?? []).map(own).filter((problem): problem is Problem => problem !== null);
  const entry = (read.document[kind] as Record<string, T>)[key] ?? null;
  return { entry: meaning.length ? null : entry, problems: meaning };
}

/** An automation's own YAML read, every problem placed in it. */
export const readAutomationYaml = (text: string, key: string, context: PrintContext = {}, check?: Check, around?: ConfigDocument) =>
  readEntry<AutomationEntry>('automations', text, key, context, check, around);

/** A device's own YAML read, every problem placed in it. */
export const readDeviceYaml = (text: string, key: string, context: PrintContext = {}, check?: Check, around?: ConfigDocument) => readEntry<DeviceEntry>('devices', text, key, context, check, around);

/** Data as YAML text: in the order given, times of day quoted, secrets by name as `!secret`. */
function yamlText(data: unknown): string {
  const yaml = new Document(data, { customTags: [secretTag] });
  // Times of day stay text: "07:00", never a number of minutes to another reader.
  if (yaml.contents)
    visitScalars(yaml.contents as Node, (scalar) => {
      if (typeof scalar.value === 'string' && /^\d{2}:\d{2}$/.test(scalar.value)) scalar.type = 'QUOTE_DOUBLE';
    });
  return yaml.toString({ lineWidth: 0, defaultKeyType: 'PLAIN', defaultStringType: 'PLAIN' });
}

/**
 * A document as YAML text: its schema line first when a URL is given, a
 * heading as comments, then the document in the order a person reads it.
 * Expressions are plain text, quoted only where YAML needs them to be.
 */
export function writeConfig(document: ConfigDocument, options: WriteContext & { schemaUrl?: string; heading?: string } = {}): string {
  const body = yamlText(documentToData(document, options));
  const head = [options.schemaUrl ? schemaLine(options.schemaUrl) : null, options.heading ? options.heading.split('\n').map((line) => (line ? `# ${line}` : '#')).join('\n') : null].filter(Boolean).join('\n');
  return head ? `${head}\n${body}` : body;
}

/** An automation's own YAML, as its page shows it. */
export function writeAutomationYaml(entry: AutomationEntry, context: PrintContext = {}): string {
  const data = documentToData({ ...emptyDocument(), automations: { entry } }, context) as { automations: { entry: unknown } };
  return yamlText(data.automations.entry);
}

/** A device's own YAML, as its page shows it. */
export function writeDeviceYaml(entry: DeviceEntry): string {
  const data = documentToData({ ...emptyDocument(), devices: { entry } }) as { devices: { entry: unknown } };
  return yamlText(data.devices.entry);
}

function visitScalars(node: Node, visit: (scalar: Scalar) => void): void {
  if (isScalar(node)) return visit(node);
  const items = (node as { items?: unknown[] }).items;
  for (const item of items ?? []) {
    if (isNode(item)) visitScalars(item, visit);
    else if (item && typeof item === 'object' && 'value' in item && isNode((item as { value: unknown }).value)) visitScalars((item as { value: Node }).value, visit);
  }
}
