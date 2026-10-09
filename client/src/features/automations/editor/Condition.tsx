import { Button, Text, XStack, YStack } from 'tamagui';

import { scriptRole, triggerIdOf, type CompareOp, type Expr } from '@kraftverk/automation';
import type { PartOption } from '@kraftverk/automation';
import { capabilitiesOf, convertible, isUnit, MAIN_PART, meetsNeed, valueTypeOf, type ConfigField, type Value, type ValueType } from '@kraftverk/device-sdk';
import { Chips, Icon, IconLabel } from '@kraftverk/ui';

import { Picker } from '../../../components/Picker';
import { useTone } from '../../../components/tone';
import { pickPart, useEditor } from './context';
import { Label, TimeField, ValueField, type Literal } from './fields';

/*
  A condition, built without showing an expression (docs/AUTOMATION-EDITOR.md):
  a part and something it reports compared with a value in that reading's own
  unit or options; whether a part can be reached; the time of day, between
  two times; what a package's function says of a part; or what one of your
  scripts' functions works out, from values and readings. Rows join as "all of" or "any of", a group may hold a group,
  and a row may be turned round ("not"). One the editor cannot draw as rows is
  said in words, and replaced whole.
*/

type Kind = 'reading' | 'reachable' | 'time' | 'ask' | 'script' | 'started' | 'all' | 'any';

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'reading', label: 'A reading' },
  { value: 'reachable', label: 'Can be reached' },
  { value: 'time', label: 'Time of day' },
  { value: 'ask', label: 'Ask a package' },
  { value: 'script', label: 'One of your scripts' },
  { value: 'started', label: 'What started it' },
  { value: 'all', label: 'All of' },
  { value: 'any', label: 'Any of' },
];

const NUMBER_OPS: { value: CompareOp; label: string }[] = [
  { value: 'lt', label: 'below' },
  { value: 'le', label: 'at most' },
  { value: 'gt', label: 'above' },
  { value: 'ge', label: 'at least' },
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
];

const EQUAL_OPS: { value: CompareOp; label: string }[] = [
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
];

/** What kind of row a condition is, as the editor draws it — or null, when it cannot. */
function kindOf(expr: Expr): Kind | null {
  if ('all' in expr) return 'all';
  if ('any' in expr) return 'any';
  if ('reachable' in expr) return 'reachable';
  // Between two times it can draw; one whose ends are not times of day it cannot.
  if ('within' in expr) return 'value' in expr.within.from && 'value' in expr.within.to ? 'time' : null;
  if ('compare' in expr && 'run' in expr.left && expr.left.run === 'trigger' && 'value' in expr.right && (expr.compare === 'eq' || expr.compare === 'ne')) return 'started';
  if ('compare' in expr && 'read' in expr.left && 'value' in expr.right) return 'reading';
  if ('compare' in expr && 'call' in expr.left && 'value' in expr.right) return 'ask';
  if ('compare' in expr && 'script' in expr.left && 'value' in expr.right) return 'script';
  return null;
}

/** The role a condition is about, to keep when its kind changes. */
function roleOf(expr: Expr): string | null {
  if ('reachable' in expr) return expr.reachable;
  if ('compare' in expr && 'read' in expr.left) return expr.left.read.role;
  if ('compare' in expr && 'call' in expr.left) return expr.left.role;
  return null;
}

/** A condition to start from: a reading of a part — the one given, or one still to choose. */
export const blankCondition = (role: string | null): Expr => blankOf('reading', role);

/** A condition of a kind, to start from: about the same part, where it was about one. */
function blankOf(kind: Kind, role: string | null): Expr {
  switch (kind) {
    case 'reading':
      return { compare: 'gt', left: { read: { role: role ?? '', means: '' } }, right: { value: 0 } };
    case 'reachable':
      return { reachable: role ?? '' };
    case 'time':
      return { within: { from: { value: '22:00' }, to: { value: '06:00' } } };
    case 'ask':
      return { compare: 'eq', left: { call: '', role: role ?? '', args: {} }, right: { value: true } };
    case 'script':
      return { compare: 'gt', left: { script: '', fn: '', args: [] }, right: { value: 0 } };
    case 'started':
      return { compare: 'eq', left: { run: 'trigger' }, right: { value: '' } };
    case 'all':
      return { all: [] };
    case 'any':
      return { any: [] };
  }
}

/** A condition, and a way to change it: the whole of it, however deep. */
export function ConditionField({ label, expr, onChange, depth = 0 }: { label: string; expr: Expr; onChange: (expr: Expr) => void; depth?: number }) {
  const tone = useTone();
  const editor = useEditor();
  const negated = 'not' in expr;
  const inner = negated ? expr.not : expr;
  const kind = kindOf(inner);
  const put = (next: Expr) => onChange(negated ? { not: next } : next);

  return (
    <YStack gap="$3" padding="$3" borderRadius="$4" borderWidth={1} borderColor="$borderColor" backgroundColor={depth % 2 ? '$background' : '$card'} aria-label={label} role="group">
      {/* Its kind among six: a list to pick from, not a row of pills wider than a phone. */}
      <Picker
        label={`${label}: what kind`}
        chosen={KIND_OPTIONS.find((option) => option.value === kind)?.label ?? null}
        placeholder="Choose what kind"
        options={KIND_OPTIONS.map((option) => ({ key: option.value, title: option.label, value: option.value, selected: option.value === kind }))}
        onPick={(next) => put(blankOf(next, roleOf(inner)))}
      />
      <XStack>
        <Chips
          label={`${label}: turned round`}
          options={[
            { value: false, label: 'So' },
            { value: true, label: 'Not so' },
          ]}
          value={negated}
          onChange={(not) => onChange(not ? { not: inner } : inner)}
        />
      </XStack>

      {kind === null ? (
        <IconLabel icon="info" size={14} color={tone('$muted')} lineHeight={20}>
          <Text fontSize={14} color="$color" lineHeight={20}>
            {editor.saidExpr(inner)} — choose a kind above to replace it.
          </Text>
        </IconLabel>
      ) : kind === 'all' || kind === 'any' ? (
        <Group expr={inner as Extract<Expr, { all: unknown } | { any: unknown }>} onChange={put} depth={depth} label={label} />
      ) : kind === 'reachable' ? (
        <Reachable expr={inner as Extract<Expr, { reachable: unknown }>} onChange={put} label={label} />
      ) : kind === 'time' ? (
        <TimeOfDay expr={inner as Extract<Expr, { within: unknown }>} onChange={put} />
      ) : kind === 'reading' ? (
        <Reading expr={inner as Extract<Expr, { compare: unknown }>} onChange={put} label={label} />
      ) : kind === 'started' ? (
        <StartedBy expr={inner as Extract<Expr, { compare: unknown }>} onChange={put} label={label} />
      ) : kind === 'script' ? (
        <ScriptFunction expr={inner as Extract<Expr, { compare: unknown }>} onChange={put} label={label} />
      ) : (
        <Ask expr={inner as Extract<Expr, { compare: unknown }>} onChange={put} label={label} />
      )}
    </YStack>
  );
}

/** "All of" or "any of": its conditions, each with a way to remove it, and one more. */
function Group({ expr, onChange, depth, label }: { expr: Extract<Expr, { all: unknown } | { any: unknown }>; onChange: (expr: Expr) => void; depth: number; label: string }) {
  const tone = useTone();
  const every = 'all' in expr;
  const parts = every ? expr.all : expr.any;
  const put = (next: readonly Expr[]) => onChange(every ? { all: next } : { any: next });
  return (
    <YStack gap="$2">
      {parts.map((part, index) => (
        <XStack key={index} gap="$2" alignItems="flex-start">
          <YStack flex={1}>
            <ConditionField label={`${label} ${index + 1}`} expr={part} depth={depth + 1} onChange={(next) => put(parts.map((one, at) => (at === index ? next : one)))} />
          </YStack>
          <Button width={44} height={44} chromeless circular aria-label={`Remove condition ${index + 1}`} icon={<Icon name="x" size={16} color={tone('$muted')} />} onPress={() => put(parts.filter((_, at) => at !== index))} />
        </XStack>
      ))}
      <Button alignSelf="flex-start" size="$3" minHeight={44} chromeless icon={<Icon name="plus" size={16} color={tone('$accent')} />} color="$accent" onPress={() => put([...parts, blankOf('reading', null)])}>
        Add a condition
      </Button>
    </YStack>
  );
}

/** A part picker for a condition: a part of your devices that fits, which fills its role. */
function PartChoice({ label, role, fits, onRole }: { label: string; role: string; fits: (option: PartOption) => boolean; onRole: (role: string) => void }) {
  const editor = useEditor();
  const options = editor.parts(() => true).filter(fits);
  return (
    <Picker
      label={label}
      chosen={editor.draft.rule.roles[role] ? editor.name(role) : null}
      placeholder="Choose a part"
      options={options.map((option) => ({ key: option.key, title: option.title, subtitle: option.subtitle, value: option, selected: option.role === role }))}
      onPick={(option) => {
        // The role first, from the draft as it stands; then the draft with it, and the condition using it.
        const picked = pickPart(editor.draft, option);
        editor.change(() => picked.draft);
        onRole(picked.role);
      }}
    />
  );
}

/**
 * Which of its own triggers started the run: one picked by what it says,
 * "When the station’s charge is below 5 % for 2 min" — given an id, if it
 * has none, for the condition to name it by.
 */
function StartedBy({ expr, onChange, label }: { expr: Extract<Expr, { compare: unknown }>; onChange: (expr: Expr) => void; label: string }) {
  const editor = useEditor();
  const when = editor.draft.rule.when;
  const id = 'value' in expr.right && typeof expr.right.value === 'string' ? expr.right.value : '';
  const chosen = when.findIndex((trigger) => trigger.id === id);
  return (
    <YStack gap="$2">
      <Label>Which of its triggers started this run</Label>
      <XStack>
        <Chips label={`${label}: is or is not`} options={EQUAL_OPS} value={expr.compare} onChange={(compare) => onChange({ ...expr, compare })} />
      </XStack>
      {when.length ? (
        <Picker
          label={`${label}: which trigger`}
          chosen={chosen >= 0 ? editor.saidTrigger(when[chosen]!) : null}
          placeholder="Choose a trigger"
          options={when.map((trigger, index) => ({ key: String(index), title: editor.saidTrigger(trigger), value: index, selected: index === chosen }))}
          onPick={(index) => {
            // The trigger first, with an id to be named by; then the condition naming it.
            const named = triggerIdOf(editor.draft.rule, index);
            editor.change((draft) => ({ ...draft, rule: named.rule }));
            onChange({ ...expr, right: { value: named.id } });
          }}
        />
      ) : (
        <Text fontSize={14} color="$muted" lineHeight={20}>
          It has no trigger yet: add one above, and choose it here.
        </Text>
      )}
    </YStack>
  );
}

function Reachable({ expr, onChange, label }: { expr: Extract<Expr, { reachable: unknown }>; onChange: (expr: Expr) => void; label: string }) {
  return (
    <YStack gap="$1.5">
      <Label>Can this be reached now?</Label>
      <PartChoice label={`${label}: which part`} role={expr.reachable} fits={() => true} onRole={(role) => onChange({ reachable: role })} />
    </YStack>
  );
}

/** Between two times of day, on the owner's clock: past midnight when the second comes first. */
function TimeOfDay({ expr, onChange }: { expr: Extract<Expr, { within: unknown }>; onChange: (expr: Expr) => void }) {
  const at = (end: Expr) => ('value' in end && typeof end.value === 'string' ? end.value : '00:00');
  const [from, to] = [at(expr.within.from), at(expr.within.to)];
  return (
    <YStack gap="$1.5">
      <Label>It is between</Label>
      <XStack gap="$2.5" alignItems="center" flexWrap="wrap">
        <TimeField label="From" value={from} onChange={(next) => onChange({ within: { from: { value: next }, to: expr.within.to } })} />
        <Text fontSize={13} color="$muted">
          and
        </Text>
        <TimeField label="Until" value={to} onChange={(next) => onChange({ within: { from: expr.within.from, to: { value: next } } })} />
      </XStack>
      {to < from ? (
        <Text fontSize={12} color="$muted">
          Across midnight: from {from} until {to} the next morning.
        </Text>
      ) : null}
    </YStack>
  );
}

/** A part, something it reports, compared with a value in its unit or options. */
function Reading({ expr, onChange, label }: { expr: Extract<Expr, { compare: unknown }>; onChange: (expr: Expr) => void; label: string }) {
  const editor = useEditor();
  const read = (expr.left as Extract<Expr, { read: unknown }>).read;
  const bound = editor.partOf(read.role);
  // What it can read of the part: what it reports that has a meaning — a charge, a draw, a state.
  const readings = bound ? bound.description.attributes.filter((attribute) => attribute.means && (attribute.part ?? MAIN_PART) === bound.part) : [];
  const chosen = readings.find((attribute) => attribute.means === read.means) ?? null;
  const type: ValueType | null = chosen?.value ?? null;
  const ordered = type?.type === 'number';
  return (
    <YStack gap="$2">
      <PartChoice
        label={`${label}: which part`}
        role={read.role}
        fits={(option) => option.description.attributes.some((attribute) => attribute.means && (attribute.part ?? MAIN_PART) === option.binding.part)}
        onRole={(role) => onChange({ ...expr, left: { read: { role, means: '' } } })}
      />
      {bound ? (
        <Picker
          label={`${label}: which reading`}
          chosen={chosen?.label ?? null}
          placeholder="Choose what it reports"
          options={readings.map((attribute) => ({ key: attribute.key, title: attribute.label, subtitle: attribute.value.type === 'number' && attribute.value.unit ? attribute.value.unit : undefined, value: attribute, selected: attribute.means === read.means }))}
          onPick={(attribute) => onChange({ compare: attribute.value.type === 'number' ? 'gt' : 'eq', left: { read: { role: read.role, means: attribute.means! } }, right: attribute.value.type === 'number' ? { value: 0, ...(attribute.value.unit ? { unit: attribute.value.unit } : {}) } : { value: attribute.value.type === 'boolean' ? true : attribute.value.type === 'enum' ? (attribute.value.options[0]?.value ?? '') : '' } })}
        />
      ) : null}
      {chosen ? (
        <YStack gap="$2">
          {ordered ? (
            <Picker
              label={`${label}: compared`}
              chosen={NUMBER_OPS.find((option) => option.value === expr.compare)?.label ?? null}
              placeholder="Choose how"
              options={NUMBER_OPS.map((option) => ({ key: option.value, title: option.label, value: option.value, selected: option.value === expr.compare }))}
              onPick={(compare) => onChange({ ...expr, compare })}
            />
          ) : (
            <Chips label={`${label}: compared`} options={EQUAL_OPS} value={expr.compare} onChange={(compare) => onChange({ ...expr, compare })} />
          )}
          <ValueField label={`${label}: value`} type={type} literal={expr.right as Literal} onChange={(right) => onChange({ ...expr, right })} />
        </YStack>
      ) : null}
    </YStack>
  );
}

/** A name in a script, as a person says it: "feelsLike" is "Feels like". */
const wordsOfName = (name: string): string => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A value to start from, of a field: nought in its unit, yes, its first option, nothing. */
const startOf = (field: ConfigField): Expr =>
  field.type === 'number' ? { value: field.default ?? 0, ...(field.unit && isUnit(field.unit) ? { unit: field.unit } : {}) } : { value: (field.type === 'boolean' ? (field.default ?? true) : field.type === 'enum' ? (field.default ?? field.options[0]?.value ?? '') : (field.default ?? '')) as Value };

/**
 * An argument of a script's function: a value, or what a part reports now —
 * a reading of the same kind: in a unit that converts to the argument's, or
 * of its type.
 */
function ArgSource({ label, field, expr, onChange }: { label: string; field: ConfigField; expr: Expr | undefined; onChange: (expr: Expr) => void }) {
  const editor = useEditor();
  const read = expr && 'read' in expr ? expr.read : null;
  const type = valueTypeOf(field);
  /** Whether what a part reports may be given here. */
  const fitting = (value: ValueType) => (type.type === 'number' ? value.type === 'number' && (!type.unit || (value.unit !== undefined && isUnit(type.unit) && isUnit(value.unit) && convertible(value.unit, type.unit))) : value.type === type.type);
  const bound = read ? editor.partOf(read.role) : null;
  const readings = bound ? bound.description.attributes.filter((attribute) => attribute.means && (attribute.part ?? MAIN_PART) === bound.part && fitting(attribute.value)) : [];
  return (
    <YStack gap="$1.5">
      <Label>{field.title}</Label>
      <XStack>
        <Chips
          label={`${label}: a value or a reading`}
          options={[
            { value: 'value', label: 'A value' },
            { value: 'reading', label: 'A reading' },
          ]}
          value={read ? 'reading' : 'value'}
          onChange={(source) => onChange(source === 'reading' ? { read: { role: '', means: '' } } : startOf(field))}
        />
      </XStack>
      {read ? (
        <>
          <PartChoice
            label={`${label}: which part`}
            role={read.role}
            fits={(option) => option.description.attributes.some((attribute) => attribute.means && (attribute.part ?? MAIN_PART) === option.binding.part && fitting(attribute.value))}
            onRole={(role) => onChange({ read: { role, means: '' } })}
          />
          {bound ? (
            <Picker
              label={`${label}: which reading`}
              chosen={readings.find((attribute) => attribute.means === read.means)?.label ?? null}
              placeholder="Choose what it reports"
              options={readings.map((attribute) => ({ key: attribute.key, title: attribute.label, subtitle: attribute.value.type === 'number' && attribute.value.unit ? attribute.value.unit : undefined, value: attribute, selected: attribute.means === read.means }))}
              onPick={(attribute) => onChange({ read: { role: read.role, means: attribute.means! } })}
            />
          ) : null}
        </>
      ) : (
        <ValueField label={`${label}: ${field.title}`} type={type} literal={expr && 'value' in expr ? (expr as Literal) : null} onChange={onChange} />
      )}
    </YStack>
  );
}

/**
 * What one of your scripts' functions works out — "how warm it feels" —
 * from values and readings, compared with the answer it waits for. Picked,
 * its script fills a role, as a "run a script" step's does.
 */
function ScriptFunction({ expr, onChange, label }: { expr: Extract<Expr, { compare: unknown }>; onChange: (expr: Expr) => void; label: string }) {
  const editor = useEditor();
  const call = expr.left as Extract<Expr, { script: unknown }>;
  const script = editor.scripts.find((each) => each.id === editor.draft.scripts?.[call.script]);
  const declared = script?.shape?.functions[call.fn] ?? null;
  const offered = editor.scripts.flatMap((each) => Object.entries(each.shape?.functions ?? {}).map(([fn, shape]) => ({ script: each, fn, shape })));
  const ordered = declared?.returns.type === 'number';
  return (
    <YStack gap="$2">
      <Picker
        label={`${label}: which function`}
        chosen={declared ? `${wordsOfName(call.fn)} — ${script!.name}` : null}
        placeholder={offered.length ? 'Choose a function' : 'No script has a function yet'}
        options={offered.map((each) => ({ key: `${each.script.id}:${each.fn}`, title: wordsOfName(each.fn), subtitle: [each.script.name, each.shape.about].filter(Boolean).join(' — '), value: each, selected: each.script.id === script?.id && each.fn === call.fn }))}
        onPick={(picked) => {
          const made = scriptRole(editor.draft, picked.script);
          editor.change(() => made.draft);
          onChange({
            compare: picked.shape.returns.type === 'number' ? 'gt' : 'eq',
            left: { script: made.role, fn: picked.fn, args: picked.shape.args.map(startOf) },
            right: startOf(picked.shape.returns),
          });
        }}
      />
      {declared?.about ? (
        <Text fontSize={13} color="$muted" lineHeight={19}>
          {declared.about}
        </Text>
      ) : null}
      {declared ? (
        <>
          {declared.args.map((field, at) => (
            <ArgSource key={at} label={`${label}: ${field.title}`} field={field} expr={call.args[at]} onChange={(next) => onChange({ ...expr, left: { ...call, args: declared.args.map((_, index) => (index === at ? next : (call.args[index] ?? startOf(declared.args[index]!)))) } })} />
          ))}
          <Label>Its answer</Label>
          {ordered ? (
            <Picker
              label={`${label}: compared`}
              chosen={NUMBER_OPS.find((option) => option.value === expr.compare)?.label ?? null}
              placeholder="Choose how"
              options={NUMBER_OPS.map((option) => ({ key: option.value, title: option.label, value: option.value, selected: option.value === expr.compare }))}
              onPick={(compare) => onChange({ ...expr, compare })}
            />
          ) : (
            <Chips label={`${label}: compared`} options={EQUAL_OPS} value={expr.compare} onChange={(compare) => onChange({ ...expr, compare })} />
          )}
          <ValueField label={`${label}: its answer`} type={valueTypeOf(declared.returns)} literal={expr.right as Literal} onChange={(right) => onChange({ ...expr, right })} />
        </>
      ) : null}
    </YStack>
  );
}

/** What a package's function says of a part — "does tomorrow look sunny?" — with its arguments, and the answer it waits for. */
function Ask({ expr, onChange, label }: { expr: Extract<Expr, { compare: unknown }>; onChange: (expr: Expr) => void; label: string }) {
  const editor = useEditor();
  const call = expr.left as Extract<Expr, { call: unknown }>;
  const fn = editor.functions.find((candidate) => candidate.id === call.call) ?? null;
  const set = (changes: Partial<Extract<Expr, { call: unknown }>>) => onChange({ ...expr, left: { ...call, ...changes } });
  return (
    <YStack gap="$2">
      <Picker
        label={`${label}: which question`}
        chosen={fn?.label ?? null}
        placeholder="Choose what to ask"
        options={editor.functions.map((candidate) => ({ key: candidate.id, title: candidate.label, subtitle: candidate.description, value: candidate, selected: candidate.id === call.call }))}
        onPick={(candidate) =>
          onChange({
            compare: 'eq',
            left: {
              call: candidate.id,
              role: call.role,
              args: Object.fromEntries(Object.entries(candidate.args).map(([name, type]) => [name, { value: type.type === 'enum' ? (type.options[0]?.value ?? '') : type.type === 'boolean' ? true : type.type === 'number' ? 0 : '' }])),
            },
            right: { value: candidate.returns.type === 'enum' ? (candidate.returns.options[0]?.value ?? '') : true },
          })
        }
      />
      {fn ? (
        <>
          <Label>Of</Label>
          <PartChoice label={`${label}: of which part`} role={call.role} fits={(option) => meetsNeed(fn.needs, capabilitiesOf(option.description, option.binding.part))} onRole={(role) => set({ role })} />
          {Object.entries(fn.args).map(([name, type]) => {
            const arg = call.args?.[name];
            return (
              <YStack key={name} gap="$1">
                <Label>{'title' in type && typeof type.title === 'string' ? type.title : name}</Label>
                <ValueField label={`${label}: ${name}`} type={type} literal={arg && 'value' in arg ? arg : null} onChange={(next) => set({ args: { ...call.args, [name]: next } })} />
              </YStack>
            );
          })}
          <Label>Its answer</Label>
          <ValueField label={`${label}: its answer`} type={fn.returns} literal={expr.right as Literal} onChange={(right) => onChange({ ...expr, right })} />
        </>
      ) : null}
    </YStack>
  );
}
