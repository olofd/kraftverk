import { isNode, isScalar, LineCounter, parseDocument, Document, Scalar, type Node, type ScalarTag } from 'yaml';

import { documentFromData, documentToData, SecretRef, type ConfigDocument } from './document.ts';
import type { PrintContext } from './expr.ts';
import { migrate } from './migrate.ts';
import type { Issue } from './rules.ts';

/*
  A configuration as YAML text, both ways (docs/CONFIG.md): read with every
  problem placed at its line and column — the YAML's own, the document's, and
  inside an expression how far into it — and written back in the order a
  person reads, `!secret name` for a secret kept by name.
*/

/** A problem in a file: what, and where — a path, and its line and column when the text is at hand. */
export type Problem = Issue & { line: number | null; column: number | null };

const secretTag: ScalarTag = {
  tag: '!secret',
  identify: (value) => value instanceof SecretRef,
  resolve: (value) => new SecretRef(value),
  stringify: (item) => (item.value as SecretRef).name,
};

/** The schema line editors read: what makes VS Code check the file as it is typed. */
export const schemaLine = (url: string) => `# yaml-language-server: $schema=${url}`;

/** A file read: its document, brought to this version — or null — and every problem, placed. */
export function readConfig(text: string, context: PrintContext = {}): { document: ConfigDocument | null; problems: Problem[]; from: number | null } {
  const lines = new LineCounter();
  const parsed = parseDocument(text, { customTags: [secretTag], lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const at = (offset: number) => {
    const position = lines.linePos(offset);
    return { line: position.line, column: position.col };
  };
  if (parsed.errors.length) {
    return { document: null, from: null, problems: parsed.errors.map((error) => ({ message: error.message.split('\n')[0]!, path: [], ...at(error.pos[0]) })) };
  }
  const data = parsed.toJS({ maxAliasCount: 100 }) as unknown;
  const place = (issue: Issue): Problem => {
    const node = issue.path.length ? (parsed.getIn(issue.path, true) as Node | undefined) : parsed.contents;
    // A key with no node of its own (a missing field) is placed at what holds it.
    const holder = !isNode(node) && issue.path.length ? (parsed.getIn(issue.path.slice(0, -1), true) as Node | undefined) : undefined;
    const found = isNode(node) ? node : isNode(holder) ? holder : null;
    if (!found?.range) return { ...issue, line: null, column: null };
    let offset = found.range[0];
    if (issue.offset !== undefined && isScalar(found)) {
      // Inside a quoted text, past its opening quote.
      offset += issue.offset + (found.type === 'QUOTE_DOUBLE' || found.type === 'QUOTE_SINGLE' ? 1 : 0);
    }
    return { ...issue, ...at(offset) };
  };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { document: null, from: null, problems: [place({ message: 'A configuration is a map: kraftverk, devices, automations …', path: [] })] };
  const migrated = migrate(data as Record<string, unknown>);
  if (!migrated.ok) return { document: null, from: null, problems: [place({ message: migrated.message, path: ['kraftverk'] })] };
  const read = documentFromData(migrated.document, context);
  return { document: read.document, from: migrated.from, problems: read.issues.map(place) };
}

/**
 * A document as YAML text: its schema line first when a URL is given, then
 * the document in the order a person reads it. Expressions are plain text,
 * quoted only where YAML needs them to be.
 */
export function writeConfig(document: ConfigDocument, options: PrintContext & { schemaUrl?: string; heading?: string } = {}): string {
  const data = documentToData(document, options);
  const yaml = new Document(data, { customTags: [secretTag] });
  // Times of day stay text: "07:00", never a number of minutes to another reader.
  yaml.contents &&
    visitScalars(yaml.contents as Node, (scalar) => {
      if (typeof scalar.value === 'string' && /^\d{2}:\d{2}$/.test(scalar.value)) scalar.type = 'QUOTE_DOUBLE';
    });
  const body = yaml.toString({ lineWidth: 0, defaultKeyType: 'PLAIN', defaultStringType: 'PLAIN' });
  const head = [options.schemaUrl ? schemaLine(options.schemaUrl) : null, options.heading ? options.heading.split('\n').map((line) => `# ${line}`).join('\n') : null].filter(Boolean).join('\n');
  return head ? `${head}\n${body}` : body;
}

function visitScalars(node: Node, visit: (scalar: Scalar) => void): void {
  if (isScalar(node)) return visit(node);
  const items = (node as { items?: unknown[] }).items;
  for (const item of items ?? []) {
    if (isNode(item)) visitScalars(item, visit);
    else if (item && typeof item === 'object' && 'value' in item && isNode((item as { value: unknown }).value)) visitScalars((item as { value: Node }).value, visit);
  }
}
