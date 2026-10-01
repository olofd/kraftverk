/**
 * What starts it, said as what comes next — not as if it had happened: "At
 * 07:00 on weekdays" is "Next at 07:00 on weekdays", "Every 15 min" "Runs
 * every 15 min", "When the charge is below 15 %" "Waiting: the charge is
 * below 15 %".
 */
export function nextSaid(trigger: string): string {
  if (/^At /.test(trigger)) return `Next at ${trigger.slice(3)}`;
  if (/^Every day at /.test(trigger)) return `Next at ${trigger.slice(13)}, every day`;
  if (/^Every /.test(trigger)) return `Runs every ${trigger.slice(6)}`;
  if (/^When /.test(trigger)) return `Waiting: ${trigger.slice(5)}`;
  return trigger;
}
