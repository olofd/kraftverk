import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { convert, isUnit, valueTypeOf, type ConfigField, type ConfigSchema, type Value } from '@kraftverk/device-sdk';
import { fieldWords, wordsOfName, type ScriptCheck, type ScriptShape } from '@kraftverk/automation';
import { changeScript, describeError, PATHS, removeScript, withConfirmation, type ScriptTried, type ScriptView } from '@kraftverk/api-client';
import { Card, haptic, Icon, RowSeparator } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Loading } from '../../components/Loading';
import { Screen } from '../../components/Screen';
import { ScriptEditor } from '../../components/ScriptEditor';
import { useTone } from '../../components/tone';
import { ValueField, type Literal } from '../automations/editor/fields';
import { ask, confirmAction } from '../../platform/confirm';
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

const fieldsOf = (schema: ConfigSchema): ConfigField[] => Object.values(schema.fields);

/** What a step or function takes, answers or keeps: each field its title and, quieter, what it holds — or, `untitled`, what it holds alone. */
function Fields({ label, fields, untitled = false }: { label: string; fields: readonly ConfigField[]; untitled?: boolean }) {
  if (!fields.length) return null;
  return (
    <YStack gap="$1">
      <Text fontSize={12} fontWeight="600" color="$muted" textTransform="uppercase" letterSpacing={0.4}>
        {label}
      </Text>
      {fields.map((field, at) =>
        untitled ? (
          <Text key={at} fontSize={14} color="$color" lineHeight={20}>
            {fieldWords(field).charAt(0).toUpperCase() + fieldWords(field).slice(1)}
          </Text>
        ) : (
          <Text key={at} fontSize={14} color="$color" lineHeight={20}>
            {field.title}
            <Text color="$muted">{` — ${fieldWords(field)}`}</Text>
          </Text>
        )
      )}
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
  const fields = Object.entries(inputs.fields);
  // Each input as written in the form: a length of time in the unit that says its default best, "10 min".
  const [values, setValues] = useState<Record<string, Literal | null>>(() => Object.fromEntries(fields.map(([key, field]) => [key, literalOf(field)])));
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState<ScriptTried | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (yes?: Record<string, string>) => {
    haptic();
    setBusy(true);
    setError(null);
    try {
      const given = Object.fromEntries(fields.map(([key, field]) => [key, valueOf(field, values[key] ?? null)]));
      const found = await api.scripts.run({ source, step: name, inputs: given, ...(yes ? { yes } : {}) });
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
    <YStack gap="$3" borderTopWidth={1} borderColor="$borderColor" paddingTop="$3" marginTop="$1">
      {fields.map(([key, field]) => (
        <YStack key={key} gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$color">
            {field.title}
          </Text>
          <ValueField label={field.title} type={valueTypeOf(field)} literal={values[key] ?? null} onChange={(next) => setValues((before) => ({ ...before, [key]: next }))} />
        </YStack>
      ))}
      <YStack gap="$1.5">
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" icon={busy ? <Spinner size="small" color="$background" /> : <Icon name="play" size={14} color={tone('$background')} />} backgroundColor="$accent" color="$background" disabled={busy || !current} opacity={busy || !current ? 0.5 : 1} onPress={() => void run()} aria-label={`Run ${wordsOfName(name)} now`}>
            Run it now
          </Button>
          {/* Run when something happens: an automation that runs this step, its trigger still to choose — of the script as kept. */}
          <Button size="$3" chromeless borderWidth={1} borderColor="$borderColor" color="$color" icon={<Icon name="zap" size={14} color={tone('$accent')} />} disabled={!kept} opacity={kept ? 1 : 0.5} onPress={() => kept && (haptic(), router.push(PATHS.automations.running(kept, name)))} aria-label={`Run ${wordsOfName(name)} when…`}>
            Run it when…
          </Button>
        </XStack>
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {kept ? 'Now: as you, as written, nothing kept — what it does to a device is done. When…: an automation runs it as kept.' : 'Now: as you, as written, nothing kept — what it does to a device is done. Keep the script to run it when something happens.'}
        </Text>
      </YStack>
      <ErrorText>{error}</ErrorText>
      {tried ? (
        // What it did, as a console reads: its own words in type, its acts with how each went, and how it ended.
        <YStack gap="$1.5" padding="$3" borderRadius="$3" borderWidth={1} borderColor={tried.fault || tried.asked.length ? '$warning' : '$borderColor'} backgroundColor="$background" role="log" aria-label={`What ${wordsOfName(name)} did`}>
          {tried.lines.map((line, at) =>
            line.kind === 'log' ? (
              <Text key={at} fontFamily="$mono" fontSize={12.5} color="$color" lineHeight={18}>
                {line.what}
              </Text>
            ) : (
              <XStack key={at} gap="$2" alignItems="flex-start">
                <YStack paddingTop={3}>
                  <Icon name={OUTCOME_ICON[line.outcome]} size={13} color={tone(line.outcome === 'done' ? '$success' : line.outcome === 'unverified' ? '$muted' : '$warning')} />
                </YStack>
                <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
                  {line.what}
                  {line.detail ? <Text color="$muted">{` — ${line.detail}`}</Text> : null}
                </Text>
              </XStack>
            )
          )}
          {tried.fault ? (
            <ErrorText>{tried.fault}</ErrorText>
          ) : (
            <Text fontSize={13} color="$success" fontWeight="600">
              {tried.answer === null ? 'Done' : `It answered: ${valueWords(tried.answer)}`}
            </Text>
          )}
          {Object.keys(tried.memory).length ? (
            <Text fontSize={12} color="$muted">
              {`It would remember: ${Object.entries(tried.memory).map(([key, value]) => `${wordsOfName(key).toLowerCase()} ${valueWords(value)}`).join(', ')}`}
            </Text>
          ) : null}
          {tried.asked.length ? (
            <YStack gap="$2" paddingTop="$1">
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

/** A field's value as the form starts it: its default — a length of time in the largest unit that says it whole — or nothing. */
function literalOf(field: ConfigField): Literal | null {
  const fallback = field.default;
  if (fallback === undefined) return null;
  if (field.type !== 'number' || typeof fallback !== 'number') return { value: fallback as Value };
  if (field.unit === 's' && fallback && fallback % 3600 === 0) return { value: fallback / 3600, unit: 'h' };
  if (field.unit === 's' && fallback && fallback % 60 === 0) return { value: fallback / 60, unit: 'min' };
  return { value: fallback, ...(field.unit && isUnit(field.unit) ? { unit: field.unit } : {}) };
}

/** What a field is given, from the form: a number in the field's own unit, whatever unit it was written in. */
function valueOf(field: ConfigField, literal: Literal | null): Value {
  if (!literal) return null;
  if (field.type === 'number' && typeof literal.value === 'number' && literal.unit && field.unit && isUnit(field.unit) && literal.unit !== field.unit) return convert(literal.value, literal.unit, field.unit);
  return literal.value;
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
        <Card key={`step:${name}`} gap="$2" aria-label={`Step ${wordsOfName(name)}`}>
          <XStack gap="$2" alignItems="baseline">
            <Text fontSize={12} color="$muted" textTransform="uppercase">
              Step
            </Text>
            <Text fontSize={16} fontWeight="600" color="$color">
              {wordsOfName(name)}
            </Text>
          </XStack>
          <About text={step.about} />
          <Fields label="It takes" fields={fieldsOf(step.inputs)} />
          <Fields label="It answers" fields={step.answer ? [step.answer] : []} untitled />
          <Fields label="It remembers" fields={fieldsOf(step.memory)} />
          <TryStep key={name} source={source} name={name} inputs={step.inputs} current={current} kept={kept} />
        </Card>
      ))}
      {functions.map(([name, fn]) => (
        <Card key={`fn:${name}`} gap="$2" aria-label={`Function ${wordsOfName(name)}`}>
          <XStack gap="$2" alignItems="baseline">
            <Text fontSize={12} color="$muted" textTransform="uppercase">
              Function
            </Text>
            <Text fontSize={16} fontWeight="600" color="$color">
              {wordsOfName(name)}
            </Text>
          </XStack>
          <About text={fn.about} />
          <Fields label="It takes, in order" fields={fn.args} />
          <Fields label="It gives" fields={[fn.returns]} untitled />
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
  /** The source a reading of failed: done with, as far as reading goes — the error says why — not read forever. */
  const [failed, setFailed] = useState<string | null>(null);
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
          setFailed(null);
        })
        .catch((err: unknown) => {
          if (ask !== asked.current) return;
          setError(describeError(err) || 'It could not be read');
          setFailed(source);
        });
    }, READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [api, source]);
  return { check: read?.check ?? null, current: read?.source === source || failed === source, error };
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
        // What automations that act with it do changes with it: the yes the home asks for that, asked here.
        const { answer, declined } = await withConfirmation(
          (confirmation) => changeScript(api, script.id, { name: name.trim(), source: kept, ...(confirmation ? { confirmation } : {}) }),
          (reason) => ({ title: `Change what “${script.name}” does?`, message: reason, yes: 'Change it', tone: 'careful' }),
          ask
        );
        if (declined || !('script' in answer)) return;
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
      const { answer, declined } = await withConfirmation(
        (confirmation) => removeScript(api, script.id, confirmation),
        (reason) => ({ title: `Remove “${script.name}” from what acts?`, message: reason, yes: 'Remove it', tone: 'careful' }),
        ask
      );
      if (declined || !('removed' in answer)) {
        setBusy(false);
        return;
      }
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
    <Screen wide back="Automations" backTo={PATHS.automations.list} title={script ? script.name : 'New script'} subtitle={script ? `${script.key} · written in TypeScript` : 'Written in TypeScript'} footer={footer}>
      <YStack gap="$4">
        <Text fontSize={14} color="$muted" lineHeight={20}>
          An async function is a step an automation runs; a plain function works out a value for a condition. Your devices, people and rooms are there by name.
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
        {check?.shape ? (
          <Declared shape={check.shape} source={source} current={current} kept={script && !changed ? script.id : null} />
        ) : check === null && !error ? (
          // Its place kept while it is first read: what follows does not jump when it comes.
          <YStack gap="$2">
            <Text role="heading" aria-level={2} fontSize={18} fontWeight="700" color="$color">
              What it declares
            </Text>
            <XStack gap="$2" alignItems="center">
              <Spinner size="small" color="$accent" />
              <Text fontSize={14} color="$muted">
                Reading it…
              </Text>
            </XStack>
          </YStack>
        ) : null}
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
