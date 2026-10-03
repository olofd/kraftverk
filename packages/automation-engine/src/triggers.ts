import { capitalise, describeTriggers, evaluateNow, EVERY_MINUTES, HOLD_MINUTES, readsRole, runsOn, slotOf, takesSteps, type Rule, type Trigger } from '@kraftverk/automation';
import { dayAfter, localTime, MAIN_PART, zonedInstant } from '@kraftverk/device-sdk';
import type { LiveMessage } from '@kraftverk/holder';

import type { RuleContext } from './context.ts';
import { actorOf, AUTOMATION_ACTOR, type AutomationEngineDeps, type AutomationRecord } from './model.ts';
import type { Runs } from './runs.ts';
import type { TriggerState } from './storage.ts';

/*
  When an automation starts on its own (docs/AUTOMATIONS.md): by the clock
  (`at`, `every`), when its device says an event happened, and when a
  condition becomes true — or has stayed true as long as it must — with each
  condition's state kept, so a restart neither loses a hold nor fires one
  twice. And keeping things so: a condition that still holds runs it again,
  unless what it would do is already so.
*/

/** Late, but not too late: a server that was down at 07:00 still acts at 07:20, not at 15:00. */
const GRACE_MS = 60 * 60_000;

export class Triggers {
  #ticking = false;
  /** Each `becomes` trigger's state, read once from the store, and its hold when one is waiting it out. */
  #becoming = new Map<string, { state: TriggerState; hold: ReturnType<typeof setTimeout> | null }>();
  /** Which automations each device's messages concern, by store revision: not every automation for every reading. */
  #index: { revision: number; byDevice: Map<string, AutomationRecord[]> } | null = null;
  readonly #context: RuleContext;
  readonly #runs: Runs;

  constructor(
    private deps: AutomationEngineDeps,
    context: RuleContext,
    runs: Runs
  ) {
    this.#context = context;
    this.#runs = runs;
  }

  /** Lets go of an automation's conditions, and the holds waiting them out: it is gone. */
  forget(automationId: string): void {
    for (const [key, entry] of this.#becoming) {
      if (!key.startsWith(`${automationId}:`)) continue;
      if (entry.hold) clearTimeout(entry.hold);
      this.#becoming.delete(key);
    }
  }

  /** Lets go of every condition and hold, and reads again what concerns each device: the automations were emptied beneath it. */
  clear(): void {
    for (const entry of this.#becoming.values()) if (entry.hold) clearTimeout(entry.hold);
    this.#becoming.clear();
    this.#index = null;
  }

  /**
   * Forgets what an automation's conditions were: after it changed — its
   * settings, its parts, its mode — what it now watches starts afresh, and a
   * condition already true is its edge. Keeping things so starts afresh too:
   * its first look a whole interval from now.
   */
  reset(automationId: string): void {
    for (const [key, entry] of this.#becoming) {
      if (!key.startsWith(`${automationId}:`)) continue;
      if (entry.hold) clearTimeout(entry.hold);
      this.#becoming.delete(key);
    }
    this.deps.store.startAfresh(automationId, this.#context.now().toISOString());
  }

  /**
   * Looks at an automation's conditions at once — just made, changed or
   * let act — rather than at the next reading or the next tick: let act
   * while a condition already holds, it acts now.
   */
  poke(automationId: string): void {
    const automation = this.deps.store.get(automationId);
    if (!automation || automation.mode === 'off') return;
    automation.rule.when.forEach((trigger, index) => {
      if ('becomes' in trigger) this.#becomes(automation, automation.rule, trigger, index);
    });
  }

  /** The automations a device's events and readings can start: bound to it, and with a trigger that listens. */
  #concerning(deviceId: string): AutomationRecord[] {
    const revision = this.deps.store.revision;
    if (this.#index?.revision !== revision) {
      const byDevice = new Map<string, AutomationRecord[]>();
      for (const automation of this.deps.store.list()) {
        if (!automation.rule.when.some((trigger) => 'event' in trigger || 'becomes' in trigger)) continue;
        for (const device of new Set(Object.values(automation.roles).map((binding) => binding.device))) {
          byDevice.set(device, [...(byDevice.get(device) ?? []), automation]);
        }
      }
      this.#index = { revision, byDevice };
    }
    return this.#index.byDevice.get(deviceId) ?? [];
  }

  /** Runs whatever is due by the clock. One tick at a time. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#context.now();
      for (const automation of this.deps.store.list()) {
        if (automation.mode === 'off') continue;
        const rule = automation.rule;
        const due = rule.when.find((trigger) => ('at' in trigger && this.#dueAt(automation, rule, trigger, now)) || ('every' in trigger && this.#dueEvery(automation, rule, trigger, now)));
        if (due) {
          // A run that takes steps goes on by itself: the clock does not wait for it.
          // Why, as the trigger reads: "Every day at 07:00", "At 07:00 on weekdays".
          const why = describeTriggers({ ...rule, when: [due] }, this.#context.settled(automation, rule), (role) => this.#context.scope(automation, rule, now).name(role), this.#context.vocabulary(automation))[0]!;
          const going = this.#runs.runAndKeep(automation, why);
          if (!takesSteps(rule)) await going;
        }
        // A condition is looked at on the clock too, not only when a reading moves: a battery that sits
        // at 8 % sends nothing, and an automation just let act must still see it is below its level.
        rule.when.forEach((trigger, index) => {
          if ('becomes' in trigger) this.#becomes(automation, rule, trigger, index);
        });
        // Keeping things so is for what a rule does at once: a sequence is started, not kept.
        if (automation.recheckMinutes && !takesSteps(rule)) await this.#recheck(automation, rule, now);
      }
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Keeping things so, when it is time to: the first condition that holds,
   * and has held as long as it must, runs the automation again — unless what
   * it would do is already so. The schedule runs from the last look, the
   * last run or the last change, whichever came last.
   */
  async #recheck(automation: AutomationRecord, rule: Rule, now: Date): Promise<void> {
    const since = Math.max(...[automation.lookedAt, automation.lastRun?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    if (now.getTime() - since < automation.recheckMinutes! * 60_000) return;
    this.deps.store.looked(automation.id, now.toISOString());

    const scope = this.#context.scope(automation, rule, now);
    for (const [index, trigger] of rule.when.entries()) {
      if (!('becomes' in trigger)) continue;
      // Fired and still true: a hold still waiting it out, or a condition that has ended, is not one.
      const state = this.#becoming.get(`${automation.id}:${index}`)?.state;
      if (!state?.last || !state.fired) continue;
      if (evaluateNow(trigger.becomes, scope) !== true) continue;
      const planned = await this.#context.plan(automation, rule, scope);
      if ('unknown' in planned) continue;
      const differing = planned.filter((change) => !('command' in change ? this.#context.alreadySo(change.command) : this.#context.settingSo(change.write)));
      if (!differing.length) return;
      // The last edge wins: what another automation set since stays, until a condition of this one turns to
      // yes again. What a person or an assistant changed is switched back: that is what keeping things so is for.
      const own = actorOf(automation);
      const others = differing.some((change) => {
        const by = ('command' in change ? this.deps.gateway.lastSwitch(change.command.binding.device, change.command.binding.part) : this.deps.gateway.lastWrite(change.write.binding.device, change.write.key))?.by;
        return by !== undefined && by.startsWith(AUTOMATION_ACTOR) && by !== own;
      });
      if (others) return;
      await this.#runs.runAndKeep(automation, `Looked again after ${automation.recheckMinutes} min, and it still holds: ${this.#context.said(automation, rule, trigger.becomes)}`);
      return;
    }
  }

  /** What a device said: an event some automation waits for, or a reading some condition reads. */
  async hear(message: LiveMessage): Promise<void> {
    if (message.kind !== 'event' && message.kind !== 'readings') return;
    for (const indexed of this.#concerning(message.deviceId)) {
      const automation = this.deps.store.get(indexed.id) ?? indexed;
      if (automation.mode === 'off') continue;
      const rule = automation.rule;
      for (const [index, trigger] of rule.when.entries()) {
        if (message.kind === 'event' && 'event' in trigger) {
          const binding = automation.roles[trigger.event.role];
          const matches = binding?.device === message.deviceId && binding.part === (message.event.part ?? MAIN_PART) && trigger.event.event === message.event.id;
          if (!matches) continue;
          const device = this.deps.device(binding);
          const label = device?.description.events?.find((event) => event.id === message.event.id)?.label ?? message.event.id;
          const going = this.#runs.runAndKeep(automation, `${device?.name ?? 'A device'} said: ${label}`);
          if (!takesSteps(rule)) await going;
        }
        if (message.kind === 'readings' && 'becomes' in trigger) {
          const watched = Object.entries(automation.roles).some(([role, binding]) => binding.device === message.deviceId && readsRole(rule, role));
          if (watched) this.#becomes(automation, rule, trigger, index);
        }
      }
    }
  }

  /**
   * A `becomes` trigger, looked at again: fires on the change to true — or
   * once it has held that long — and, with no state kept yet, on a condition
   * already true. Its state is kept after every change, so a restart resumes
   * a hold with the time it had left and never fires one twice.
   */
  #becomes(automation: AutomationRecord, rule: Rule, trigger: Extract<Trigger, { becomes: unknown }>, index: number): void {
    const key = `${automation.id}:${index}`;
    const scope = this.#context.scope(automation, rule);
    const now = evaluateNow(trigger.becomes, scope);
    // Unknown — a device gone quiet — changes nothing: neither a start nor an end.
    if (typeof now !== 'boolean') return;

    let entry = this.#becoming.get(key);
    if (!entry) {
      // Nothing kept: as if it had been false, so a condition already true is its edge.
      entry = { state: this.deps.store.trigger(automation.id, index) ?? { last: false, heldSince: null, fired: false }, hold: null };
      this.#becoming.set(key, entry);
    }
    const { state } = entry;
    const keep = () => this.deps.store.keepTrigger(automation.id, index, state);

    if (!now) {
      if (entry.hold) clearTimeout(entry.hold);
      entry.hold = null;
      if (state.last || state.heldSince || state.fired) {
        Object.assign(state, { last: false, heldSince: null, fired: false });
        keep();
      }
      return;
    }

    const turned = !state.last;
    if (turned) {
      Object.assign(state, { last: true, heldSince: this.#context.now().toISOString(), fired: false });
      keep();
    }
    // True, and already dealt with — or already waiting it out.
    if (state.fired || entry.hold) return;

    const said = capitalise(this.#context.said(automation, rule, trigger.becomes));
    // A setting filled in later is held to a hold's bounds here too: a timer past them would not wait at all.
    const asked = trigger.heldForMinutes ? Number(evaluateNow(trigger.heldForMinutes, scope)) : 0;
    const minutes = Number.isFinite(asked) ? Math.min(HOLD_MINUTES.max, Math.max(0, asked)) : 0;
    const fire = (why: string) => {
      const current = this.deps.store.get(automation.id);
      // Turned off since — or gone — it does nothing.
      if (!current || current.mode === 'off') return;
      // Still taking its steps: not dealt with, so looked at again — and started once that run ends, if it still holds.
      if (this.#runs.busy(automation.id)) return;
      state.fired = true;
      keep();
      void this.#runs.runAndKeep(current, why);
    };
    const since = Date.parse(state.heldSince ?? this.#context.now().toISOString());
    const remaining = minutes > 0 ? since + minutes * 60_000 - this.#context.now().getTime() : 0;
    if (remaining <= 0) {
      fire(minutes > 0 ? `${said}, for ${minutes} min` : said);
      return;
    }
    entry.hold = setTimeout(() => {
      entry.hold = null;
      try {
        // Still true, all this time? Only then.
        if (evaluateNow(trigger.becomes, this.#context.scope(automation, rule)) !== true) return;
        fire(`${said}, for ${minutes} min`);
      } catch (error) {
        // A timer has nobody to throw to: what went wrong is said, never left to bring the server down.
        console.error(`[automations] ${automation.id} could not fire after its hold:`, error);
      }
    }, remaining);
    (entry.hold as { unref?: () => void }).unref?.();
  }

  #dueAt(automation: AutomationRecord, rule: Rule, trigger: Extract<Trigger, { at: unknown }>, now: Date): boolean {
    const at = evaluateNow(trigger.at, this.#context.scope(automation, rule));
    const [hour, minute] = typeof at === 'string' ? at.split(':').map(Number) : [];
    if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return false;
    const lastStarted = Math.max(...[automation.lastRun?.at, automation.running?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    // Today's, or yesterday's still within its grace: 23:30's, with the server back at 00:05.
    return [localTime(now, automation.timeZone), dayAfter(now, automation.timeZone, -1)].some((day) => {
      // Only on its days, on the owner's calendar.
      if (!runsOn(trigger, day)) return false;
      const time = zonedInstant({ ...day, hour, minute }, automation.timeZone);
      const since = now.getTime() - time.getTime();
      if (since < 0 || since > GRACE_MS) return false;
      return !Number.isFinite(lastStarted) || lastStarted < time.getTime();
    });
  }

  /** Whether an interval's latest slot, on the owner's clock, has come and it has not run since: once a slot, never catching up. */
  #dueEvery(automation: AutomationRecord, rule: Rule, trigger: Extract<Trigger, { every: unknown }>, now: Date): boolean {
    const every = evaluateNow(trigger.every, this.#context.scope(automation, rule));
    if (typeof every !== 'number' || every < EVERY_MINUTES.min || every > EVERY_MINUTES.max) return false;
    const today = localTime(now, automation.timeZone);
    const minuteOfDay = today.hour * 60 + today.minute;
    const slot = slotOf(minuteOfDay, every);
    // Its start, counted back from now on the clock now shown: in the hour repeated as clocks go back, each of the two has its own slots.
    const time = new Date(now.getTime() - (now.getTime() % 60_000) - (minuteOfDay - slot) * 60_000);
    const lastStarted = Math.max(...[automation.lastRun?.at, automation.running?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    return time.getTime() <= now.getTime() && (!Number.isFinite(lastStarted) || lastStarted < time.getTime());
  }
}
