/**
 * Configuration as a language (docs/CONFIG.md): a kraftverk home - its
 * devices, how each is reached, the links between them, its automations - as
 * one versioned YAML document, read with every problem's line and written
 * back the same; its rules in words whose parse tree is the rule; checked by
 * a JSON Schema and by what it means, from a vocabulary of what is installed.
 * Pure: the server and the app run it alike.
 */

export * from './check.ts';
export * from './document.ts';
export * from './expr.ts';
export * from './migrate.ts';
export * from './rules.ts';
export * from './schema.ts';
export * from './vocabulary.ts';
export * from './yaml.ts';
