import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import type { ConfigField, ConfigSchema, ConfigValues, Value } from '@kraftverk/device-sdk';
import type { ScriptCheck, ScriptShape } from '@kraftverk/automation';
import { describeError, PATHS, type ScriptTried, type ScriptView } from '@kraftverk/api-client';
import { Card, haptic, Icon, RowSeparator, SchemaForm } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Loading } from '../../components/Loading';
import { Screen } from '../../components/Screen';
import { ScriptEditor } from '../../components/ScriptEditor';
import { useTone } from '../../components/tone';
import { confirmAction } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';

/** What a new script starts as: one step and one function, written as the SDK has them now. */
const STARTER = `import { devices, family, home, log, type Celsius, type Duration, type Kept, type Percent } from 'kraftverk';

/** Turns off what was left on, once the house has been empty a while. */
export async function tidyUp(
  /** Empty for at least. @min 1 min @default 10 min */
  after: Duration,
  memory: Kept<{ times: number }>,
): Promise<string> {
  memory.times += 1;
  log(\`Tidied \${memory.times} times; anyone home: \${home.occupied}\`);
  // Your devices, people and rooms are here by name: type "devices." and choose.
  return \`Empty for \${after / 60} min\`;
}

/** How warm it feels, from the temperature and how humid it is. */
export function feelsLike(temp: Celsius, humidity: Percent): Celsius {
  return temp - (100 - humidity) / 5;
}
`;

/** How long typing rests before the script is read again. */
const READ_AFTER_MS = 300;

/** A name as a person says it: "tidyUp" is "Tidy up". */
const wordsOf = (name: string): string => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A number as a person reads it beside its unit: a length of time in the largest units that say it, "1 h 30 min". */
const amount = (value: number, unit: string | undefined): string => {
  if (unit !== 's') return `${value}${unit ? ` ${unit}` : ''}`;
  const [hours, minutes, seconds] = [Math.floor(value / 3_600), Math.floor((value % 3_600) / 60), value % 60];
  return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', seconds || !value ? `${seconds} s` : ''].filter(Boolean).join(' ');
};

/** A field in words: its title, and what it holds. */
const fieldWords = (field: ConfigField): string => {
  const kind =
    field.type === 'number'
      ? [field.unit === 's' ? 'a length of time' : field.unit, field.integer ? 'whole' : null, field.min !== undefined ? `from ${amount(field.min, field.unit)}` : null, field.max !== undefined ? `to ${amount(field.max, field.unit)}` : null, field.default !== undefined ? `at first ${amount(field.default, field.unit)}` : null].filter(Boolean).join(', ') || 'a number'
      : field.type === 'boolean'
        ? 'yes or no'
        : field.type === 'enum'
          ? field.options.map((option) => option.label).join(' · ')
          : field.type === 'timestamp'
            ? 'a date and time'
            : 'text';
  return `${field.title} — ${kind}`;
};

const fieldsOf = (schema: ConfigSchema): ConfigField[] => Object.values(schema.fields);

function Fields({ label, fields }: { label: string; fields: readonly ConfigField[] }) {
  if (!fields.length) return null;
  return (
    <YStack gap={2}>
      <Text fontSize={13} color="$muted">
        {label}
      </Text>
      {fields.map((field, at) => (
        <Text key={at} fontSize={14} color="$color">
          {fieldWords(field)}
        </Text>
      ))}
    </YStack>
  );
}

/**
 * A step tried, in the browser's console as well: what the script said with
 * `log` as its own lines, what it did beside them, its answer, its fault —
 * each under the step's name, as a developer reads a run.
 */
function toConsole(name: string, tried: ScriptTried) {
  const at = `[${name}]`;
  for (const line of tried.lines) {
    if (line.kind === 'log') console.log(at, line.what);
    else (line.outcome === 'refused' || line.outcome === 'failed' ? console.warn : console.info)(at, line.what, ...(line.detail ? [`— ${line.detail}`] : []));
  }
  if (tried.fault) console.error(at, tried.fault);
  else console.info(at, tried.answer === null ? 'done' : 'answered', ...(tried.answer === null ? [] : [tried.answer]));
}

/** What a value is, as a person reads it. */
const valueWords = (value: Value | null): string => (value === null ? 'nothing' : typeof value === 'string' ? value : JSON.stringify(value));

/**
 * One of a script's steps, tried now as written: its inputs given, and run
 * as the person — through the gateway, so what it does to a device is done.
 * What it did, line by line; what it answered and would remember; and a
 * yes asked for, given by running it again.
 */
function TryStep({ source, name, inputs, current, kept }: { source: string; name: string; inputs: ConfigSchema; current: boolean; kept: string | null }) {
  const { api } = useFamily();
  const tone = useTone();
  const [values, setValues] = useState<ConfigValues>(() => Object.fromEntries(Object.entries(inputs.fields).map(([key, field]) => [key, field.default as ConfigValues[string]])));
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState<ScriptTried | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (yes?: Record<string, string>) => {
    haptic();
    setBusy(true);
    setError(null);
    try {
      const found = await api.scripts.run({ source, step: name, inputs: Object.fromEntries(Object.keys(inputs.fields).map((key) => [key, (values[key] ?? null) as Value])), ...(yes ? { yes } : {}) });
      toConsole(name, found);
      setTried(found);
    } catch (err) {
      setTried(null);
      setError(describeError(err) || 'It could not be run');
    } finally {
      setBusy(false);
    }
  };
  const OUTCOME_ICON = { done: 'check', refused: 'slash', failed: 'x-circle', unverified: 'help-circle' } as const;
  return (
    <YStack gap="$2" borderTopWidth={1} borderColor="$borderColor" paddingTop="$2.5" marginTop="$1">
      {Object.keys(inputs.fields).length ? <SchemaForm schema={inputs} values={values} disabled={busy} onChange={(key, value) => setValues((before) => ({ ...before, [key]: value }))} /> : null}
      <XStack alignItems="center" gap="$3">
        <Button size="$3" icon={busy ? <Spinner size="small" /> : <Icon name="play" size={14} color={tone('$background')} />} backgroundColor="$accent" color="$background" disabled={busy || !current} opacity={busy || !current ? 0.5 : 1} onPress={() => void run()} aria-label={`Run ${wordsOf(name)} now`}>
          Run it now
        </Button>
        <Text flex={1} fontSize={12} color="$muted" lineHeight={17}>
          As you, as written — not kept. What it does to a device is done.
        </Text>
      </XStack>
      {/* Run when something happens: an automation that runs this step, its trigger still to choose — of the script as kept. */}
      <XStack alignItems="center" gap="$3">
        <Button size="$3" chromeless borderWidth={1} borderColor="$accent" color="$accent" icon={<Icon name="zap" size={14} color={tone('$accent')} />} disabled={!kept} opacity={kept ? 1 : 0.5} onPress={() => kept && (haptic(), router.push(PATHS.automations.running(kept, name)))} aria-label={`Run ${wordsOf(name)} when…`}>
          Run it when…
        </Button>
        {kept ? null : (
          <Text flex={1} fontSize={12} color="$muted" lineHeight={17}>
            Keep it first: an automation runs it as it is kept.
          </Text>
        )}
      </XStack>
      <ErrorText>{error}</ErrorText>
      {tried ? (
        <YStack gap="$1.5" role="log" aria-label={`What ${wordsOf(name)} did`}>
          {tried.lines.map((line, at) => (
            <XStack key={at} gap="$2" alignItems="flex-start">
              <YStack paddingTop={3}>
                <Icon name={OUTCOME_ICON[line.outcome]} size={13} color={tone(line.outcome === 'done' ? '$success' : line.outcome === 'unverified' ? '$muted' : '$warning')} />
              </YStack>
              <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
                {line.what}
                {line.detail ? <Text color="$muted">{` — ${line.detail}`}</Text> : null}
              </Text>
            </XStack>
          ))}
          {tried.fault ? (
            <ErrorText>{tried.fault}</ErrorText>
          ) : (
            <Text fontSize={13} color="$success" fontWeight="600">
              {tried.answer === null ? 'Done' : `It answered: ${valueWords(tried.answer)}`}
            </Text>
          )}
          {Object.keys(tried.memory).length ? (
            <Text fontSize={12} color="$muted">
              {`It would remember: ${Object.entries(tried.memory).map(([key, value]) => `${key} ${valueWords(value)}`).join(', ')}`}
            </Text>
          ) : null}
          {tried.asked.length ? (
            <YStack gap="$2" padding="$2.5" borderRadius="$3" borderWidth={1} borderColor="$warning">
              {tried.asked.map((need) => (
                <Text key={need.key} fontSize={13} color="$color" lineHeight={19}>
                  {`It needs your yes: ${need.what}`}
                </Text>
              ))}
              <Button size="$3" alignSelf="flex-start" chromeless borderWidth={1} borderColor="$warning" color="$warning" disabled={busy} onPress={() => void run(Object.fromEntries(tried.asked.map((need) => [need.key, need.token])))}>
                Yes — run it again
              </Button>
            </YStack>
          ) : null}
        </YStack>
      ) : null}
    </YStack>
  );
}

/** A doc comment's words, under a step's or function's name. */
function About({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Text fontSize={13} color="$muted" lineHeight={19}>
      {text}
    </Text>
  );
}

/** What a script declares, as a person reads it: its steps and its functions, each with what it takes and gives — and each step tried. */
function Declared({ shape, source, current, kept }: { shape: ScriptShape; source: string; current: boolean; kept: string | null }) {
  const steps = Object.entries(shape.steps);
  const functions = Object.entries(shape.functions);
  return (
    <YStack gap="$3" role="region" aria-label="What it declares">
      <Text role="heading" aria-level={2} fontSize={18} fontWeight="700" color="$color">
        What it declares
      </Text>
      {steps.map(([name, step]) => (
        <Card key={`step:${name}`} gap="$2" aria-label={`Step ${wordsOf(name)}`}>
          <XStack gap="$2" alignItems="baseline">
            <Text fontSize={12} color="$muted" textTransform="uppercase">
              Step
            </Text>
            <Text fontSize={16} fontWeight="600" color="$color">
              {wordsOf(name)}
            </Text>
          </XStack>
          <About text={step.about} />
          <Fields label="It takes" fields={fieldsOf(step.inputs)} />
          <Fields label="It answers" fields={step.answer ? [step.answer] : []} />
          <Fields label="It remembers" fields={fieldsOf(step.memory)} />
          <TryStep key={name} source={source} name={name} inputs={step.inputs} current={current} kept={kept} />
        </Card>
      ))}
      {functions.map(([name, fn]) => (
        <Card key={`fn:${name}`} gap="$2" aria-label={`Function ${wordsOf(name)}`}>
          <XStack gap="$2" alignItems="baseline">
            <Text fontSize={12} color="$muted" textTransform="uppercase">
              Function
            </Text>
            <Text fontSize={16} fontWeight="600" color="$color">
              {wordsOf(name)}
            </Text>
          </XStack>
          <About text={fn.about} />
          <Fields label="It takes, in order" fields={fn.args} />
          <Fields label="It gives" fields={[fn.returns]} />
        </Card>
      ))}
    </YStack>
  );
}

/**
 * A source, read again by the home's engine each time typing rests: what it
 * declares, or its problems. What was read last stays shown while the next
 * reading is made, so the page keeps its height and place as it is typed in;
 * `current` says whether it was read from the source as it is now.
 */
function useRead(source: string): { check: ScriptCheck | null; current: boolean; error: string | null } {
  const { api } = useFamily();
  const [read, setRead] = useState<{ source: string; check: ScriptCheck } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      api.scripts
        .check(source)
        .then((check) => {
          if (ask !== asked.current) return;
          setRead({ source, check });
          setError(null);
        })
        .catch((err: unknown) => {
          if (ask !== asked.current) return;
          setError(describeError(err) || 'It could not be read');
        });
    }, READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [api, source]);
  return { check: read?.check ?? null, current: read?.source === source, error };
}

/** The automations that run a kept script, or call one of its functions: each a way to its page. */
function UsedBy({ automations }: { automations: ScriptView['usedBy'] }) {
  return (
    <YStack gap="$2" role="region" aria-label="Used by">
      <Text role="heading" aria-level={2} fontSize={18} fontWeight="700" color="$color">
        Used by
      </Text>
      {automations.length ? (
        <Card inset>
          {automations.map((automation, index) => (
            <YStack key={automation.id}>
              {index ? <RowSeparator /> : null}
              <XStack role="link" aria-label={automation.name} cursor="pointer" padding="$3" gap="$3" alignItems="center" pressStyle={{ opacity: 0.6 }} onPress={() => router.push(PATHS.automations.one(automation.id))}>
                <Icon name="zap" size={16} />
                <Text flex={1} fontSize={15} fontWeight="600" color="$color">
                  {automation.name}
                </Text>
                <Icon name="chevron-right" size={16} />
              </XStack>
            </YStack>
          ))}
        </Card>
      ) : (
        <Text fontSize={14} color="$muted" lineHeight={20}>
          No automation runs it yet: "Run it when…" under one of its steps makes one.
        </Text>
      )}
    </YStack>
  );
}

/** The script itself: its name, its source, what it declares, and keeping it. */
function ScriptForm({ script }: { script: ScriptView | null }) {
  const { api } = useFamily();
  const tone = useTone();
  const [name, setName] = useState(script?.name ?? '');
  const [source, setSource] = useState(script?.source ?? STARTER);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { check, current, error } = useRead(source);
  // The home's types, for the editor's checking and completion: asked once, as the page opens.
  const [types, setTypes] = useState<string | null>(null);
  const [typesProblem, setTypesProblem] = useState<string | null>(null);
  useEffect(() => {
    api.scripts
      .types()
      .then((found) => (setTypes(found), setTypesProblem(null)))
      .catch((err: unknown) => setTypesProblem(`Your home's types could not be read, so the editor checks without them: ${describeError(err) || 'it did not say why'}`));
  }, [api]);

  const changed = script === null || name.trim() !== script.name || source !== script.source;
  const problems = check?.problems.length ?? 0;
  const ready = Boolean(name.trim()) && current && problems === 0 && changed;

  /** The editor's formatter, while it is open: the script formatted before it is kept. */
  const formatter = useRef<(() => Promise<string>) | null>(null);
  const save = async () => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      // Formatted as TypeScript formats it, first; as written, where the editor has no formatter.
      const kept = (await formatter.current?.().catch(() => null)) ?? source;
      if (script) {
        await api.scripts.update(script.id, { name: name.trim(), source: kept });
        router.replace(PATHS.automations.list);
      } else {
        const made = await api.scripts.create({ name: name.trim(), source: kept });
        router.replace(PATHS.scripts.one(made.id));
      }
    } catch (err) {
      setProblem(describeError(err) || 'It could not be kept');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!script) return;
    const using = script.usedBy.length ? ` ${script.usedBy.map((each) => `“${each.name}”`).join(', ')} ${script.usedBy.length === 1 ? 'runs' : 'run'} it: ${script.usedBy.length === 1 ? 'it has' : 'they have'} nothing to run then.` : '';
    if (!(await confirmAction(`Remove "${script.name}"?`, `Its source is gone with it: export it first to keep a copy.${using}`, 'Remove', 'careful'))) return;
    setBusy(true);
    try {
      await api.scripts.remove(script.id);
      router.replace(PATHS.automations.list);
    } catch (err) {
      setProblem(describeError(err) || 'It could not be removed');
      setBusy(false);
    }
  };

  const footer = (
    <YStack gap="$2">
      {problem ? <ErrorText>{problem}</ErrorText> : null}
      <XStack alignItems="center" gap="$2">
        <XStack flex={1} alignItems="center" gap="$2">
          {!current ? <Spinner size="small" color="$accent" /> : <Icon name={problems ? 'alert-triangle' : name.trim() ? 'check-circle' : 'edit-3'} size={16} color={tone(problems ? '$warning' : name.trim() ? '$success' : '$muted')} />}
          <Text flex={1} fontSize={14} fontWeight="600" color={!current || (!problems && !name.trim()) ? '$muted' : problems ? '$warning' : '$success'} numberOfLines={1}>
            {!current ? 'Reading…' : problems ? `${problems} thing${problems === 1 ? '' : 's'} to fix` : !name.trim() ? 'Give it a name to keep it' : 'Ready'}
          </Text>
        </XStack>
        {script ? (
          <Button size="$4" chromeless color="$danger" disabled={busy} onPress={() => void remove()}>
            Remove
          </Button>
        ) : null}
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy || !ready} opacity={busy || !ready ? 0.5 : 1} onPress={() => void save()}>
          {busy ? 'Keeping…' : script ? 'Save changes' : 'Keep it'}
        </Button>
      </XStack>
    </YStack>
  );

  return (
    <Screen back="Automations" backTo={PATHS.automations.list} title={script ? script.name : 'New script'} subtitle={script ? `${script.key} · written in TypeScript` : 'Written in TypeScript'} footer={footer}>
      <YStack gap="$4">
        <Text fontSize={14} color="$muted" lineHeight={20}>
          A script is what an automation does, or a value it works out: an async function is a step, a plain function a value for a condition. Your devices, people, homes and rooms are there by name. What it declares is read as you write, and a step can be run from here as it is.
        </Text>
        <YStack gap="$1.5">
          <Text fontSize={13} color="$muted">
            Its name
          </Text>
          <Input aria-label="Its name" placeholder="Tidy up" size="$4" maxLength={60} value={name} onChangeText={setName} />
        </YStack>
        <ScriptEditor value={source} onChange={setSource} problems={check?.problems ?? []} label="The script" types={types} formatter={formatter} />
        <ErrorText>{error}</ErrorText>
        <ErrorText>{typesProblem}</ErrorText>
        {check?.shape ? <Declared shape={check.shape} source={source} current={current} kept={script && !changed ? script.id : null} /> : null}
        {script ? <UsedBy automations={script.usedBy} /> : null}
      </YStack>
    </Screen>
  );
}

/**
 * A script (docs/PLAN-SCRIPTS.md): a new one, or one the family keeps —
 * read as it is typed by the home's own engine, the server's or this
 * browser's, which says what it declares or what is wrong with it, by
 * line; kept when it reads without a problem.
 */
export function ScriptPage({ id }: { id: string | null }) {
  const { api } = useFamily();
  const [script, setScript] = useState<ScriptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    api.scripts
      .get(id)
      .then((found) => (setScript(found), setError(null)))
      .catch((err: unknown) => setError(describeError(err) || 'It could not be read'));
  }, [api, id]);

  if (id && !script)
    return (
      <Screen back="Automations" backTo={PATHS.automations.list} title="Script">
        <Loading error={error} />
      </Screen>
    );
  return <ScriptForm key={script?.id ?? 'new'} script={script} />;
}
