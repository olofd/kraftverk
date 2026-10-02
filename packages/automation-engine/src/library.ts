import { checkRule, STANDARD_RECIPES, type AutomationContribution, type AutomationFunction, type Recipe } from '@kraftverk/automation';

/**
 * What automations can be made from (docs/AUTOMATIONS.md): the shared
 * vocabulary's recipes — rules in library capabilities and standard meanings
 * only, which any device that offers them fills — and what the installed
 * packages bring: their own recipes, and the functions rules call. The core
 * holds none of its own. Each recipe is checked as a rule against every
 * installed function, so one that calls a function no package provides is
 * refused at start, saying which, rather than failing at 07:00.
 */

/** What one installed package brings to automations, and whose it is. */
export type Contributed = { contribution: AutomationContribution; from: { typeId: string; name: string } };

export type RecipeEntry = {
  recipe: Recipe;
  /** The type it came with, as people know its package; null for the shared vocabulary's. */
  from: { typeId: string; name: string } | null;
};

export class AutomationLibrary {
  #recipes = new Map<string, RecipeEntry>();
  #functions = new Map<string, AutomationFunction>();
  #refused: { id: string; problems: string[] }[] = [];

  constructor(contributed: readonly Contributed[], log: (message: string) => void = console.warn) {
    for (const { contribution } of contributed) for (const fn of contribution.functions ?? []) this.#functions.set(fn.id, fn);
    const offer = (recipe: Recipe, from: RecipeEntry['from']) => {
      const problems = [
        ...(this.#recipes.has(recipe.id) ? [`another package already has a recipe "${recipe.id}"`] : []),
        ...checkRule(recipe, { fn: (id) => this.fn(id) }),
      ];
      if (problems.length) {
        this.#refused.push({ id: recipe.id, problems });
        log(`[automations] The recipe ${recipe.id} from ${from?.typeId ?? 'the shared vocabulary'} is not offered:\n  - ${problems.join('\n  - ')}`);
        return;
      }
      this.#recipes.set(recipe.id, { recipe, from });
    };
    for (const recipe of STANDARD_RECIPES) offer(recipe, null);
    for (const { contribution, from } of contributed) for (const recipe of contribution.recipes ?? []) offer(recipe, from);
  }

  recipe(id: string): Recipe | null {
    return this.#recipes.get(id)?.recipe ?? null;
  }

  recipes(): RecipeEntry[] {
    return [...this.#recipes.values()];
  }

  fn(id: string): AutomationFunction | null {
    return this.#functions.get(id) ?? null;
  }

  /** Every installed function: what a condition an owner builds may ask. */
  functions(): AutomationFunction[] {
    return [...this.#functions.values()];
  }

  get refused(): readonly { id: string; problems: string[] }[] {
    return this.#refused;
  }
}
