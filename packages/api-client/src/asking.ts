import { ApiError, type AutomationChanges, type AutomationId, type AutomationView, type ImportAnswers, type ImportApplied, type KraftverkApi } from '@kraftverk/api-contract';

/*
  What a screen does with a refusal that only wants a person's yes: shows the
  question, and sends the call again with the token. Over any home — a
  server's or the app's own — the refusal is the same `ApiError`; these give
  it back as an answer, so a screen asks rather than fails.
*/

/** The work done, or the yes it wants first; any other refusal thrown as it was. */
export async function askingYes<T>(work: Promise<T>): Promise<{ done: T } | { needsConfirmation: string; reason: string }> {
  try {
    return { done: await work };
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'needs-yes' && error.needsConfirmation) return { needsConfirmation: error.needsConfirmation, reason: error.message };
    throw error;
  }
}

/** An automation changed — or, letting it act or changing one that acts, the yes that wants first. */
export async function changeAutomation(api: KraftverkApi, id: string, changes: AutomationChanges): Promise<{ automation: AutomationView } | { needsConfirmation: string; reason: string }> {
  const answer = await askingYes(api.automations.update(id as AutomationId, changes));
  return 'done' in answer ? { automation: answer.done } : answer;
}

/** An import's plan applied — or the yes it wants first, or why it cannot be, every problem listed. */
export async function applyPlan(api: KraftverkApi, answers: ImportAnswers): Promise<{ applied: ImportApplied } | { needsConfirmation: string; reason: string } | { refused: string; problems: string[] }> {
  try {
    const answer = await askingYes(api.configuration.apply(answers));
    return 'done' in answer ? { applied: answer.done } : answer;
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'invalid') return { refused: error.message, problems: [...error.problems] };
    throw error;
  }
}
