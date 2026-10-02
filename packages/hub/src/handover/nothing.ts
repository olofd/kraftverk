import type { ImportPlan } from '@kraftverk/api-contract';

/** Whether bringing a home in would change nothing: all of it is here already, as it is there. */
export function nothingToDo(plan: ImportPlan): boolean {
  return (
    plan.id !== null &&
    plan.devices.every((item) => item.action === 'same') &&
    plan.automations.every((item) => item.action === 'same') &&
    plan.links.every((link) => link.action === 'same') &&
    plan.policy.every((value) => value.before === value.after)
  );
}
