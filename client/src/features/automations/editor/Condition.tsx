import { Button, Text, XStack, YStack } from 'tamagui';

import { MAIN_PART, meetsNeed, capabilitiesOf, type CompareOp, type Expr, type ValueType, type Value } from '@kraftverk/device-sdk';
import { Icon } from '@kraftverk/ui';

import { useTone } from '../looks';
import { pickPart, useEditor, type PartOption } from './context';
import { Chips, Label, Picker, TimeField, ValueField } from './fields';

/*
  A condition, built without showing an expression (docs/AUTOMATION-EDITOR.md):
  a part and something it reports compared with a value in that reading's own
  unit or options; whether a part can be reached; the time of day, between
  two times; or what a package's function says of a part. Rows join as "all of" or "any of", a group may hold a group,
  and a row may be turned round ("not"). One the editor cannot draw as rows is
  said in words, and replaced whole.
*/

type Kind = 'reading' | 'reachable' | 'time' | 'ask' | 'all' | 'any';

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'reading', label: 'A reading' },
  { value: 'reachable', label: 'Can be reached' },
  { value: 'time', label: 'Time of day' },
  { value: 'ask', label: 'Ask a package' },
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
  if ('compare' in expr && 'read' in expr.left && 'value' in expr.right) return 'reading';
  if ('compare' in expr && 'call' in expr.left && 'value' in expr.right) return 'ask';
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
    <YStack gap="$2" padding="$2.5" borderRadius="$3" borderWidth={1} borderColor="$borderColor" backgroundColor={depth % 2 ? '$background' : '$backgroundPress'} aria-label={label} role="group">
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Chips label={`${label}: what kind`} options={KIND_OPTIONS} value={kind} onChange={(next) => put(blankOf(next, roleOf(inner)))} />
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
        <XStack gap="$2" alignItems="flex-start">
          <Icon name="info" size={13} color={tone('$muted')} style={{ marginTop: 3 }} />
          <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
            {editor.saidExpr(inner)} — choose a kind above to replace it.
          </Text>
        </XStack>
      ) : kind === 'all' || kind === 'any' ? (
        <Group expr={inner as Extract<Expr, { all: unknown } | { any: unknown }>} onChange={put} depth={depth} label={label} />
      ) : kind === 'reachable' ? (
        <Reachable expr={inner as Extract<Expr, { reachable: unknown }>} onChange={put} label={label} />
      ) : kind === 'time' ? (
        <TimeOfDay expr={inner as Extract<Expr, { within: unknown }>} onChange={put} />
      ) : kind === 'reading' ? (
        <Reading expr={inner as Extract<Expr, { compare: unknown }>} onChange={put} label={label} />
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
          <Button size="$2" chromeless circular aria-label={`Remove condition ${index + 1}`} icon={<Icon name="x" size={14} color={tone('$muted')} />} onPress={() => put(parts.filter((_, at) => at !== index))} />
        </XStack>
      ))}
      <Button alignSelf="flex-start" size="$2" chromeless icon={<Icon name="plus" size={13} color={tone('$accent')} />} color="$accent" onPress={() => put([...parts, blankOf('reading', null)])}>
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
  const value = (expr.right as Extract<Expr, { value: unknown }>).value;
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
          onPick={(attribute) => onChange({ compare: attribute.value.type === 'number' ? 'gt' : 'eq', left: { read: { role: read.role, means: attribute.means! } }, right: { value: attribute.value.type === 'boolean' ? true : attribute.value.type === 'enum' ? (attribute.value.options[0]?.value ?? '') : 0 } })}
        />
      ) : null}
      {chosen ? (
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <Chips label={`${label}: compared`} options={ordered ? NUMBER_OPS : EQUAL_OPS} value={expr.compare} onChange={(compare) => onChange({ ...expr, compare })} />
          <ValueField label={`${label}: value`} type={type} value={value} onChange={(next: Value) => onChange({ ...expr, right: { value: next } })} />
        </XStack>
      ) : null}
    </YStack>
  );
}

/** What a package's function says of a part — "does tomorrow look sunny?" — with its arguments, and the answer it waits for. */
function Ask({ expr, onChange, label }: { expr: Extract<Expr, { compare: unknown }>; onChange: (expr: Expr) => void; label: string }) {
  const editor = useEditor();
  const call = expr.left as Extract<Expr, { call: unknown }>;
  const value = (expr.right as Extract<Expr, { value: unknown }>).value;
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
                <ValueField label={`${label}: ${name}`} type={type} value={arg && 'value' in arg ? arg.value : null} onChange={(next) => set({ args: { ...call.args, [name]: { value: next } } })} />
              </YStack>
            );
          })}
          <Label>Its answer</Label>
          <ValueField label={`${label}: its answer`} type={fn.returns} value={value} onChange={(next) => onChange({ ...expr, right: { value: next } })} />
        </>
      ) : null}
    </YStack>
  );
}
