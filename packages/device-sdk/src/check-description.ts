import { isCapability, isPolicyValueName, requiredMeanings, type CapabilitySpec } from './capabilities.ts';
import { attributeMeaning, capabilitiesOf, capabilityIn, isStandardPartKind, MAIN_PART, partOf, partsOf, quantityOf, type DeviceDescription } from './description.ts';
import { QUANTITIES, STANDARD_NAMESPACES, standardMeaning, STATE_CLASSES, unitsOfMeaning } from './meanings.ts';
import { ATTRIBUTE_KEY, NAMESPACED_ID, NAMESPACED_NAME, PART_ID, PLAIN_ID } from './names.ts';
import { valueTypeProblems } from './values.ts';

/*
  Checking a description (docs/ARCHITECTURE.md §4.5): every part, attribute,
  event and capability of its own a type declares is one there can be —
  named as names are, meaning what standard meanings mean, offering what
  its attributes carry — each problem said, all of them at once.
*/

/** Every problem with one of a type's own capabilities: the library's rules, and its name. */
function capabilityProblems(id: string, spec: CapabilitySpec, typeId: string): string[] {
  const problems: string[] = [];
  const where = `capability "${id}"`;
  if (isCapability(id)) return [`${where} is in the library; a type declares only its own`];
  if (!id.startsWith(`${typeId}.`) || !NAMESPACED_NAME.test(id)) problems.push(`${where} must be namespaced by the type: "${typeId}.something"`);
  if (!spec.label?.trim()) problems.push(`${where} has no label`);
  for (const [name, attribute] of Object.entries(spec.attributes ?? {})) {
    if (!standardMeaning(attribute.means)) problems.push(`${where} attribute "${name}" means "${attribute.means}", which is not a standard meaning`);
  }
  for (const [name, command] of Object.entries(spec.commands ?? {})) {
    for (const [arg, type] of Object.entries(command.args ?? {})) problems.push(...valueTypeProblems(`${where} command "${name}" argument "${arg}"`, type));
    for (const [arg, attribute] of Object.entries(command.sets ?? {})) {
      if (!(arg in (command.args ?? {}))) problems.push(`${where} command "${name}" sets from "${arg}", which it does not take`);
      if (!(attribute in (spec.attributes ?? {}))) problems.push(`${where} command "${name}" sets "${attribute}", which it does not have`);
    }
    const consequence = command.consequential;
    if (consequence && consequence !== 'always') {
      for (const condition of consequence.if ?? []) {
        if (!standardMeaning(condition.means)) problems.push(`${where} command "${name}" is consequential by "${condition.means}", which is not a standard meaning`);
        for (const bound of [condition.above, condition.below]) {
          if (bound !== undefined && typeof bound !== 'number' && !isPolicyValueName(bound.policy)) problems.push(`${where} command "${name}" names the policy value "${bound.policy}", which there is none of`);
        }
      }
    }
  }
  for (const [name, query] of Object.entries(spec.queries ?? {})) problems.push(...valueTypeProblems(`${where} query "${name}" answer`, query.answer));
  return problems;
}

/**
 * Every problem with a description, not just the first — the static half of
 * the device model's contract. `typeId` names the type's own namespace, for
 * its own meanings and capabilities.
 */
export function validateDescription(description: DeviceDescription, typeId = 'brand.model'): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);

  // --- its own capabilities ---------------------------------------------------------
  for (const [id, spec] of Object.entries(description.capabilities ?? {})) problems.push(...capabilityProblems(id, spec, typeId));

  // --- parts --------------------------------------------------------------------
  const parts = partsOf(description);
  const partIds = new Set<string>();
  for (const part of description.parts ?? []) {
    if (!PART_ID.test(part.id ?? '')) problem(`part id "${part.id}" must be lowercase words, dotted: "outlet.ac", "pack.1"`);
    if (partIds.has(part.id)) problem(`part "${part.id}" is declared twice`);
    partIds.add(part.id);
    if (!part.label?.trim() && part.id !== MAIN_PART) problem(`part "${part.id}" has no label`);
    if (!isStandardPartKind(part.kind ?? '')) {
      if (!NAMESPACED_ID.test(part.kind ?? '')) problem(`part "${part.id}" is a "${part.kind}", which is not a kind; a kind of the type's own is namespaced, like "${typeId.split('.')[0]}.hopper"`);
      else if (!part.icon) problem(`part "${part.id}" is a kind of the type's own, "${part.kind}", and needs an icon`);
    }
    if (part.icon !== undefined && !PLAIN_ID.test(part.icon)) problem(`part "${part.id}" has an icon "${part.icon}", which is not a Feather icon name`);
    if (part.energy && !['source', 'storage', 'load'].includes(part.energy.role)) problem(`part "${part.id}" has an unknown energy role "${part.energy.role}"`);
  }
  partIds.add(MAIN_PART);
  for (const part of parts) {
    if (part.parent !== undefined && !partIds.has(part.parent)) problem(`part "${part.id}" belongs to "${part.parent}", which is not a part`);
    for (const name of part.offers ?? []) {
      const spec = capabilityIn(description, name);
      if (!spec) {
        problem(`part "${part.id}" offers "${name}", which is neither in the library nor declared by the type`);
        continue;
      }
      for (const meaning of requiredMeanings(spec)) {
        if (!attributeMeaning(description, part.id, meaning)) problem(`part "${part.id}" offers "${name}", which needs an attribute meaning "${meaning}"`);
      }
    }
  }
  const otherParts = [...partIds].filter((id) => id !== MAIN_PART);

  // --- attributes ----------------------------------------------------------------
  const keys = new Set<string>();
  const primaries = new Map<string, number>();
  const meanings = new Set<string>();
  for (const attribute of description.attributes ?? []) {
    const where = `attribute "${attribute.key}"`;
    const part = partOf(attribute);
    if (!ATTRIBUTE_KEY.test(attribute.key ?? '')) problem(`an attribute has no usable key ("${attribute.key}")`);
    if (keys.has(attribute.key)) problem(`${where} is declared twice`);
    keys.add(attribute.key);
    if (!partIds.has(part)) problem(`${where} belongs to "${part}", which is not a part`);
    else if (part !== MAIN_PART && !attribute.key?.startsWith(`${part}.`)) problem(`${where} is on "${part}", so its key begins "${part}.": "${part}.${attribute.key}"`);
    else if (part === MAIN_PART) {
      const claimed = otherParts.find((id) => attribute.key?.startsWith(`${id}.`));
      if (claimed) problem(`${where} is on main, but its key begins with the part "${claimed}"`);
    }
    if (!attribute.label?.trim()) problem(`${where} has no label`);
    problems.push(...valueTypeProblems(where, attribute.value));
    if (attribute.category === 'primary') primaries.set(part, (primaries.get(part) ?? 0) + 1);
    if (attribute.currentFor !== undefined && !(Number.isInteger(attribute.currentFor) && attribute.currentFor > 0)) problem(`${where} is current for ${attribute.currentFor} ms; a whole number of milliseconds above zero`);

    if (attribute.stateClass !== undefined) {
      if (!STATE_CLASSES.includes(attribute.stateClass)) problem(`${where} has an unknown state class "${attribute.stateClass}"`);
      else if (attribute.value?.type !== 'number') problem(`${where} has a state class, which only a number can have`);
    }
    if (attribute.quantity !== undefined) {
      if (attribute.value?.type !== 'number') problem(`${where} names a quantity, which only a number has`);
      else if (!QUANTITIES.includes(attribute.quantity)) problem(`${where} has an unknown quantity "${attribute.quantity}"`);
    }
    if (attribute.dangerous && attribute.access !== 'write') problem(`${where} is dangerous but cannot be written; a command's danger is its capability's`);
    if (attribute.category === 'config' && attribute.access !== 'write') problem(`${where} is a setting that cannot be written`);
    if (attribute.access === 'write' && (attribute.value?.type === 'list' || attribute.value?.type === 'object')) problem(`${where} is a setting with structure; a setting is one value`);

    if (attribute.means === undefined) continue;
    const meaningInPart = `${part}:${attribute.means}`;
    if (meanings.has(meaningInPart)) problem(`part "${part}" has two attributes meaning "${attribute.means}"`);
    meanings.add(meaningInPart);

    const standard = standardMeaning(attribute.means);
    if (standard?.type === 'boolean') {
      if (attribute.value?.type !== 'boolean') problem(`${where} means ${attribute.means}, which is on or off, but is not a boolean`);
    } else if (standard) {
      const standardState = standard.stateClass ?? 'measurement';
      if (attribute.value?.type !== 'number' || !unitsOfMeaning(standard).includes(attribute.value.unit ?? '') || quantityOf(attribute) !== standard.quantity) {
        problem(`${where} means ${attribute.means}, which is ${standard.quantity} in ${unitsOfMeaning(standard).map((unit) => `"${unit}"`).join(' or ')}`);
      } else if ((attribute.stateClass ?? 'measurement') !== standardState) {
        problem(`${where} means ${attribute.means}, which is ${standardState}, but is declared ${attribute.stateClass ?? 'measurement'}`);
      }
    } else {
      const namespace = attribute.means.split('.')[0]!;
      if (!attribute.means.includes('.') || STANDARD_NAMESPACES.includes(namespace)) {
        problem(`${where} means "${attribute.means}", which is not a standard meaning; a type's own are namespaced by the type, like "${typeId.split('.').pop()}.${attribute.key}"`);
      }
    }
  }
  for (const [part, count] of primaries) if (count > 1) problem(`part "${part}" has ${count} primary attributes; one leads its card`);

  // --- events --------------------------------------------------------------------
  const events = new Set<string>();
  for (const event of description.events ?? []) {
    if (!ATTRIBUTE_KEY.test(event.id ?? '')) problem(`an event has no usable id ("${event.id}")`);
    if (events.has(event.id)) problem(`event "${event.id}" is declared twice`);
    events.add(event.id);
    if (!event.label?.trim()) problem(`event "${event.id}" has no label`);
    if (!['info', 'warn', 'error'].includes(event.level)) problem(`event "${event.id}" has an unknown level "${event.level}"`);
    const part = event.part ?? MAIN_PART;
    if (!partIds.has(part)) problem(`event "${event.id}" belongs to "${part}", which is not a part`);
    // An event a capability of the part declares is that event: the same level, whatever the device calls it.
    for (const capability of partIds.has(part) ? capabilitiesOf(description, part) : []) {
      const standard = capabilityIn(description, capability)?.events?.[event.id];
      if (standard && standard.level !== event.level) problem(`event "${event.id}" is ${capability}'s, which is ${standard.level}, but is declared ${event.level}`);
    }
    for (const [name, type] of Object.entries(event.data ?? {})) problems.push(...valueTypeProblems(`event "${event.id}" data "${name}"`, type));
  }

  return problems;
}
