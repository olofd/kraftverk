import type { CapabilityName, ConfigSchema, ConfigValues, DeviceSession, SavedDeviceId, WeatherHour } from '@kraftverk/device-sdk';

import { dayAfter, localTime, zonedInstant } from './time.ts';

/**
 * Recipes: whole behaviours the core implements, with roles you fill with
 * devices (docs/PROJECT-BRIEF.md, "Wiring"; docs/ARCHITECTURE.md step 14).
 *
 * A recipe names capabilities, never products. Each role says what a device
 * must offer to fill it, so the editor offers only devices that fit and an
 * incompatible piece cannot be connected. Every guard lives here and in the
 * gateway, not in what a person configures: a recipe only ever *decides*, and
 * what it decides to do goes through the gateway like any command from a
 * screen — dwell, freshness, read-only mode, verification and the audit.
 */

export type AutomationMode = 'off' | 'observe' | 'armed';

export type AutomationRecord = {
  id: string;
  name: string;
  recipe: string;
  /** Which device fills each role. */
  roles: Record<string, SavedDeviceId>;
  params: ConfigValues;
  /** The owner's clock, from the app it was made in: "Europe/Stockholm". */
  timeZone: string;
  mode: AutomationMode;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastResult: RunResult | null;
};

export type RoleSpec = {
  label: string;
  description: string;
  /** What a device must offer to fill the role. */
  capabilities: readonly CapabilityName[];
};

/** A device, as a recipe may see it. */
export type RecipeDevice = { name: string; session: DeviceSession | null; offline: string };

export type RecipeContext = {
  automation: AutomationRecord;
  now: Date;
  device(role: string): RecipeDevice | null;
};

/** What a recipe decided. It never acts itself. */
export type Decision =
  /** Do this, through the gateway, and say why. */
  | { kind: 'act'; role: string; capability: CapabilityName; command: string; target?: string; value: boolean; reason: string }
  /** The condition is not met: nothing to do. */
  | { kind: 'idle'; reason: string }
  /** It cannot tell — a forecast that is not there is not a sunny one. Nothing is done. */
  | { kind: 'unknown'; reason: string };

export type RunOutcome =
  | 'acted' // the gateway carried it out, verified
  | 'unverified' // the gateway sent it, but the effect is not proven
  | 'would-act' // observing: it would have acted
  | 'idle' // the condition was not met
  | 'unknown' // it could not tell
  | 'refused' // the gateway said no
  | 'failed'; // the command errored

export type RunResult = { at: string; outcome: RunOutcome; summary: string };

export type Recipe = {
  id: string;
  label: string;
  description: string;
  roles: Record<string, RoleSpec>;
  params: ConfigSchema;
  /** Whether it should run now, given when it last ran. */
  due(automation: AutomationRecord, now: Date): boolean;
  decide(ctx: RecipeContext): Decision;
  /** One sentence for the list: "At 07:00, if today looks sunny, turn Heater plug on." */
  describe(automation: AutomationRecord, name: (role: string) => string): string;
};

// --- forecast switch ------------------------------------------------------------

const HOURS = Array.from({ length: 18 }, (_, i) => String(i + 5).padStart(2, '0') + ':00');

/** The hours a day's sunshine is judged over, on the owner's clock: 09:00 to 17:00. */
const DAYLIGHT = { from: 9, to: 17 };

/** Late, but not too late: a server that was down at 07:00 still acts at 07:20, not at 15:00. */
const GRACE_MS = 60 * 60_000;

/**
 * "If tomorrow is sunny, turn the plug on" — or off, or on a cloudy day.
 *
 * Once a day, at the hour chosen, it reads the forecast for the day chosen and
 * judges it by the average cloud cover between 09:00 and 17:00 there. A
 * forecast that is missing, or does not reach that day, decides nothing.
 */
export const forecastSwitch: Recipe = {
  id: 'forecast-switch',
  label: 'Switch by the forecast',
  description: 'Once a day, switch something on or off depending on whether the day looks sunny.',
  roles: {
    forecast: { label: 'Forecast', description: 'Where the forecast comes from', capabilities: ['weather.forecast'] },
    switch: { label: 'What to switch', description: 'A plug, or anything else that switches', capabilities: ['switch'] },
  },
  params: {
    fields: {
      at: {
        type: 'enum',
        title: 'When',
        description: 'The time of day it looks at the forecast and acts.',
        default: '07:00',
        options: HOURS.map((hour) => ({ value: hour, label: hour })),
      },
      day: {
        type: 'enum',
        title: 'Which day',
        default: 'today',
        options: [
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
        ],
      },
      condition: {
        type: 'enum',
        title: 'If it looks',
        default: 'sunny',
        options: [
          { value: 'sunny', label: 'Sunny' },
          { value: 'cloudy', label: 'Cloudy' },
        ],
      },
      cloudMax: {
        type: 'number',
        title: 'Sunny means cloud cover at most',
        description: 'The average between 09:00 and 17:00.',
        unit: '%',
        min: 0,
        max: 100,
        step: 5,
        default: 40,
      },
      action: {
        type: 'enum',
        title: 'Then turn it',
        default: 'on',
        options: [
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
      },
    },
  },

  due(automation, now) {
    const at = runTime(automation, now);
    const since = now.getTime() - at.getTime();
    if (since < 0 || since > GRACE_MS) return false;
    return automation.lastRunAt === null || Date.parse(automation.lastRunAt) < at.getTime();
  },

  decide({ automation, now, device }) {
    const params = automation.params;
    const forecast = device('forecast');
    if (!forecast) return { kind: 'unknown', reason: 'Its forecast is no longer one of your devices' };
    const capability = forecast.session?.capability('weather.forecast') ?? null;
    if (!capability) return { kind: 'unknown', reason: `${forecast.name} is not answering: ${forecast.offline}` };

    const which = params.day === 'tomorrow' ? 'tomorrow' : 'today';
    const date = dayAfter(now, automation.timeZone, which === 'tomorrow' ? 1 : 0);
    const from = zonedInstant({ ...date, hour: DAYLIGHT.from, minute: 0 }, automation.timeZone).getTime();
    const to = zonedInstant({ ...date, hour: DAYLIGHT.to, minute: 0 }, automation.timeZone).getTime();
    const hours = capability.hourly(72).filter((hour: WeatherHour) => {
      const at = Date.parse(hour.at);
      return at >= from && at < to;
    });
    const clouds = hours.map((hour) => hour.cloudCoverPercent).filter((value): value is number => typeof value === 'number');
    const expected = DAYLIGHT.to - DAYLIGHT.from;
    if (clouds.length < expected) {
      return { kind: 'unknown', reason: `${forecast.name}'s forecast does not cover ${which} between 09:00 and 17:00` };
    }

    const cloud = Math.round(clouds.reduce((sum, value) => sum + value, 0) / clouds.length);
    const sunny = cloud <= Number(params.cloudMax ?? 40);
    const looks = sunny ? 'sunny' : 'cloudy';
    const wanted = params.condition === 'cloudy' ? 'cloudy' : 'sunny';
    const reason = `${capitalise(which)} looks ${looks}: ${cloud} % cloud on average between 09:00 and 17:00`;
    if (looks !== wanted) return { kind: 'idle', reason };
    return { kind: 'act', role: 'switch', capability: 'switch', command: 'set', value: params.action !== 'off', reason };
  },

  describe(automation, name) {
    const params = automation.params;
    return `At ${params.at ?? '07:00'}, if ${params.day === 'tomorrow' ? 'tomorrow' : 'today'} looks ${params.condition === 'cloudy' ? 'cloudy' : 'sunny'} by ${name('forecast')}, turn ${name('switch')} ${params.action === 'off' ? 'off' : 'on'}.`;
  },
};

/** Today's run time, on the automation's own clock. */
function runTime(automation: AutomationRecord, now: Date): Date {
  const [hour, minute] = String(automation.params.at ?? '07:00').split(':').map(Number);
  const today = localTime(now, automation.timeZone);
  return zonedInstant({ ...today, hour: hour ?? 7, minute: minute ?? 0 }, automation.timeZone);
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Every recipe the core offers. Rules — the open tier — come after. */
export const RECIPES: readonly Recipe[] = [forecastSwitch];

export const recipeOf = (id: string): Recipe | null => RECIPES.find((recipe) => recipe.id === id) ?? null;
