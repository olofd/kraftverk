import { checkRule, type AutomationFunction, type DeviceType, type Recipe } from '@kraftverk/device-sdk';

/**
 * What the installed packages bring to automations (docs/AUTOMATIONS.md):
 * their recipes and the functions rules call. Found with the device types —
 * the core holds no recipe of its own — and each recipe checked as a rule
 * against every installed function, so one that calls a function no package
 * provides is refused at start, saying which, rather than failing at 07:00.
 */

export type RecipeEntry = {
  recipe: Recipe;
  /** The type it came with: its package, as people know it. */
  from: { typeId: string; name: string };
};

export class AutomationLibrary {
  #recipes = new Map<string, RecipeEntry>();
  #functions = new Map<string, AutomationFunction>();
  #refused: { id: string; problems: string[] }[] = [];

  constructor(types: readonly DeviceType<any>[], log: (message: string) => void = console.warn) {
    for (const type of types) for (const fn of type.automation?.functions ?? []) this.#functions.set(fn.id, fn);
    for (const type of types) {
      for (const recipe of type.automation?.recipes ?? []) {
        const problems = [
          ...(this.#recipes.has(recipe.id) ? [`another package already has a recipe "${recipe.id}"`] : []),
          ...checkRule(recipe, { fn: (id) => this.fn(id) }),
        ];
        if (problems.length) {
          this.#refused.push({ id: recipe.id, problems });
          log(`[automations] The recipe ${recipe.id} from ${type.id} is not offered:\n  - ${problems.join('\n  - ')}`);
          continue;
        }
        this.#recipes.set(recipe.id, { recipe, from: { typeId: type.id, name: type.meta.name } });
      }
    }
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
