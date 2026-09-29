import { checkRule, STANDARD_RECIPES, type AutomationFunction, type DeviceType, type Recipe } from '@kraftverk/device-sdk';

/**
 * What automations can be made from (docs/AUTOMATIONS.md): the shared
 * vocabulary's recipes — rules in library capabilities and standard meanings
 * only, which any device that offers them fills — and what the installed
 * packages bring: their own recipes, and the functions rules call. The core
 * holds none of its own. Each recipe is checked as a rule against every
 * installed function, so one that calls a function no package provides is
 * refused at start, saying which, rather than failing at 07:00.
 */

export type RecipeEntry = {
  recipe: Recipe;
  /** The type it came with, as people know its package; null for the shared vocabulary's. */
  from: { typeId: string; name: string } | null;
};

export class AutomationLibrary {
  #recipes = new Map<string, RecipeEntry>();
  #functions = new Map<string, AutomationFunction>();
  #refused: { id: string; problems: string[] }[] = [];

  constructor(types: readonly DeviceType<any>[], log: (message: string) => void = console.warn) {
    for (const type of types) for (const fn of type.automation?.functions ?? []) this.#functions.set(fn.id, fn);
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
    for (const type of types) for (const recipe of type.automation?.recipes ?? []) offer(recipe, { typeId: type.id, name: type.meta.name });
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

  get refused(): readonly { id: string; problems: string[] }[] {
    return this.#refused;
  }
}
