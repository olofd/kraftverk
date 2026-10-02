import type { AutomationFunction, Recipe } from './rule.ts';
import { checkRule } from './rule.ts';

/**
 * What a package brings to automations (docs/AUTOMATIONS.md): recipes — rules
 * with roles and settings left open — and functions a rule can call.
 *
 * Its own entry in the package's package.json, beside its device type and its
 * screens — `"kraftverk": { "automation": "./src/automation.ts" }` — whose
 * default export is this. The device contract knows nothing of automations:
 * a package that offers them imports this language, as it imports the SDK.
 */
export type AutomationContribution = {
  readonly recipes?: readonly Recipe[];
  readonly functions?: readonly AutomationFunction[];
};

export const defineContribution = (contribution: AutomationContribution): AutomationContribution => contribution;

/**
 * Whether a package's contribution keeps the rules: every id namespaced by the
 * package's device type, so two packages can never ship the same one; each
 * declared once, labelled, and every recipe checked as a rule — against the
 * functions it brings, the rest checked again once everything is installed.
 */
export function checkContribution(contribution: AutomationContribution, namespace: string): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);
  const functions = contribution.functions ?? [];
  const recipes = contribution.recipes ?? [];
  const namespaced = (kind: string, id: string) => {
    if (!id?.startsWith(`${namespace}.`) || !/^[a-z0-9.-]+\.[a-z][A-Za-z0-9-]*$/.test(id)) problem(`${kind} "${id}" must be namespaced by the type: "${namespace}.something"`);
  };
  const seen = new Set<string>();
  for (const fn of functions) {
    namespaced('function', fn.id);
    if (seen.has(fn.id)) problem(`function "${fn.id}" is declared twice`);
    seen.add(fn.id);
    if (!fn.label?.trim()) problem(`function "${fn.id}" has no label`);
    if (typeof fn.evaluate !== 'function') problem(`function "${fn.id}" cannot be evaluated`);
  }
  for (const recipe of recipes) {
    namespaced('recipe', recipe.id);
    if (seen.has(recipe.id)) problem(`recipe "${recipe.id}" is declared twice`);
    seen.add(recipe.id);
    if (!recipe.label?.trim() || !recipe.description?.trim()) problem(`recipe "${recipe.id}" needs a label and a description`);
    const own = (id: string) => functions.find((fn) => fn.id === id) ?? null;
    for (const found of checkRule(recipe, { fn: own })) {
      // Another package's function is checked when everything is installed.
      if (!/there is no function ".*" installed/.test(found)) problem(`recipe "${recipe.id}": ${found}`);
    }
    for (const placeholder of recipe.sentence?.match(/\{(\w+)\}/g) ?? []) {
      const key = placeholder.slice(1, -1);
      if (!(key in recipe.roles) && !(key in recipe.params.fields)) problem(`recipe "${recipe.id}": its sentence names "${key}", which is neither a role nor a setting`);
    }
  }
  return problems;
}
