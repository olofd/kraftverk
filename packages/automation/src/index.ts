/**
 * kraftverk's automation language (README.md is its reference): a rule's
 * triggers, steps and expressions as data; checking, describing, evaluating
 * and editing them; their text form, as a configuration file writes them;
 * the standard recipes; and what a package brings to automations.
 *
 * Pure — no runtime, no platform — so the server, the app and every package
 * run it alike. Running automations is `@kraftverk/automation-engine`'s.
 */

export * from './rule.ts';
export * from './recipes.ts';
export * from './contribution.ts';
export * from './edit.ts';
export * from './draft.ts';
export * from './text/expr.ts';
export * from './text/rules.ts';
