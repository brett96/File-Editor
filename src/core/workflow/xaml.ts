/**
 * Windows Workflow / UiPath workflow files (.xaml): reading them as a tree of activities and
 * editing that tree in place, for the workflow designer (src/ui/workflow).
 *
 * The XML DOM is the model. Edits change it in place, and everything the designer doesn't show
 * (view state, selectors' settings, assembly references, attributes it doesn't know) is kept as
 * it was. `serializeXaml` writes the document back the way Studio writes it: an unchanged
 * document comes back byte for byte, and new elements are indented like their neighbours. (The
 * browser's XMLSerializer can't be used: it writes newlines inside attribute values as is,
 * which turns UiPath's multi-line selectors and expressions into one line when read again.)
 */

export const NS = {
  activities: 'http://schemas.microsoft.com/netfx/2009/xaml/activities',
  x: 'http://schemas.microsoft.com/winfx/2006/xaml',
  ui: 'http://schemas.uipath.com/workflow/activities',
  sap: 'http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation',
  sap2010: 'http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  xmlns: 'http://www.w3.org/2000/xmlns/',
} as const;

/** Namespaces the designer's new activities and variable types may need, by their usual prefix. */
export const KNOWN_PREFIXES: Record<string, string> = {
  x: NS.x,
  ui: NS.ui,
  s: 'clr-namespace:System;assembly=mscorlib',
  scg: 'clr-namespace:System.Collections.Generic;assembly=mscorlib',
  sd: 'clr-namespace:System.Data;assembly=System.Data',
};

/** Elements of the workflow namespaces that hold values or wiring, not activities. */
const NOT_ACTIVITIES = new Set([
  'InArgument',
  'OutArgument',
  'InOutArgument',
  'Variable',
  'DelegateInArgument',
  'DelegateOutArgument',
  'ActivityAction',
  'ActivityFunc',
  'Catch',
  'AssemblyReference',
  'FlowStep',
  'FlowDecision',
  'FlowSwitch',
  'State',
  'Transition',
  'PickBranch',
  'Target',
  'CursorPosition',
  'Region',
  'VisualBasicValue',
  'VisualBasicReference',
  'CSharpValue',
  'CSharpReference',
  'Members',
  'Property',
]);
/** Namespaces whose elements are never activities (XAML language, designer data, collections). */
const NOT_ACTIVITY_NS = new Set([NS.x, NS.sap, NS.sap2010, NS.mc, 'clr-namespace:System.Collections.Generic;assembly=mscorlib', 'clr-namespace:System;assembly=mscorlib']);
/** Property elements that hold activities (besides any holding an ActivityAction or a Catch). */
const SLOT_PROPS = new Set(['Body', 'Then', 'Else', 'Try', 'Finally', 'Handler', 'Activities', 'Default', 'Action', 'Trigger', 'Branches', 'Catches', 'Cases', 'Nodes', 'StartNode', 'Entry', 'Exit', 'States']);
/** Containers that hold a list of activities as their content (the rest hold one). */
const LIST_CONTAINERS = new Set(['Sequence', 'Parallel', 'Flowchart', 'StateMachine', 'Pick', 'ParallelForEach']);
/** Activities that can declare variables. */
export const VARIABLE_SCOPES = new Set(['Sequence', 'Flowchart', 'StateMachine', 'Parallel', 'Pick', 'TryCatch']);

export interface ParsedWorkflow {
  doc: XMLDocument;
  /** the root <Activity> element */
  root: Element;
  /** the workflow's top activity (usually a Sequence or a Flowchart), or null when it is empty */
  main: Element | null;
  /** the text before the root element (an XML declaration), kept as it was */
  prolog: string;
  bom: boolean;
  /** the file's line ending: XML reading turns "\r\n" into "\n", so it is put back on writing */
  eol: '\n' | '\r\n';
  /** whitespace after the root element */
  epilog: string;
}

/** Whether a .xaml file's text is a workflow (and not, say, a WPF window). */
export function isWorkflowXaml(text: string): boolean {
  const head = text.slice(0, 4000);
  return /<Activity\b/.test(head) && (head.includes(NS.activities) || head.includes('schemas.uipath.com'));
}

export function parseXaml(text: string): ParsedWorkflow {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const doc = new DOMParser().parseFromString(body, 'application/xml') as XMLDocument;
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`The XAML isn't valid XML: ${(err.textContent ?? '').trim().split('\n')[0].slice(0, 200)}`);
  const root = doc.documentElement;
  if (root.localName !== 'Activity') throw new Error('This XAML file is not a workflow (its root is not an Activity).');
  const start = body.indexOf('<' + root.nodeName);
  const eol = /\r\n/.test(body.slice(0, 4000)) ? '\r\n' : '\n';
  return { doc, root, main: activityChildren(root)[0] ?? null, prolog: start > 0 ? body.slice(0, start) : '', bom, eol, epilog: /\s*$/.exec(body)![0] };
}

// ── what is what ─────────────────────────────────────────────────────────────
const elements = (n: Node): Element[] => Array.from(n.childNodes).filter((c): c is Element => c.nodeType === 1);

/** `Assign.To`, `ui:Click.Target`: an element naming a property of its parent. */
export const isPropertyElement = (el: Element) => el.localName.includes('.');

export function isActivity(el: Element): boolean {
  if (isPropertyElement(el)) return false;
  if (NOT_ACTIVITY_NS.has(el.namespaceURI ?? '')) return false;
  if (NOT_ACTIVITIES.has(el.localName)) return false;
  return true;
}

/** Activities placed directly inside an element (its content), skipping wiring. */
export function activityChildren(el: Element): Element[] {
  return elements(el).filter(isActivity);
}

/** A place an activity holds other activities: its content, or a property such as If.Then. */
export interface Slot {
  /** "Then", "Else", "Body", "Try", "Catch Exception", "Finally"… ("" for a container's content) */
  label: string;
  /** the element the slot's activities are children of */
  host: Element;
  /** holds several activities in order (a Sequence's content) or just one */
  list: boolean;
  activities: Element[];
  /** for a Catch: the exception type it catches */
  catchType?: string;
  /** the For Each / Catch variable the body sees ("row", "exception") */
  argument?: string;
}

/** The ActivityAction inside an element, whose content is the activity a body runs. */
function actionOf(el: Element): Element | null {
  return elements(el).find((c) => c.localName === 'ActivityAction' || c.localName === 'ActivityFunc') ?? null;
}

function delegateArgument(action: Element): string | undefined {
  const arg = elements(action).find((c) => c.localName === 'ActivityAction.Argument' || c.localName === 'ActivityFunc.Argument');
  const d = arg ? elements(arg).find((c) => c.localName === 'DelegateInArgument') : undefined;
  return d?.getAttribute('Name') ?? undefined;
}

export const friendlyType = (t: string | null | undefined): string => {
  if (!t) return '';
  return t
    .replace(/\b[a-z0-9]+:/gi, '')
    .replace(/\(/g, '<')
    .replace(/\)/g, '>');
};

/** Where `activity` keeps the activities it runs. */
export function slotsOf(activity: Element): Slot[] {
  const slots: Slot[] = [];
  const own = activityChildren(activity);
  const name = activity.localName;
  const direct = actionOf(activity);
  if (direct) {
    // ForEach<T>: its body is an ActivityAction placed as content
    slots.push({ label: 'Body', host: direct, list: false, activities: activityChildren(direct), argument: delegateArgument(direct) });
  }
  if (own.length || LIST_CONTAINERS.has(name) || (!direct && !elements(activity).some(isPropertyElement) && CONTENT_BODY.has(name))) {
    if (own.length || LIST_CONTAINERS.has(name) || CONTENT_BODY.has(name)) {
      slots.push({ label: LIST_CONTAINERS.has(name) ? '' : 'Body', host: activity, list: LIST_CONTAINERS.has(name), activities: own });
    }
  } else if (CONTENT_BODY.has(name)) {
    slots.push({ label: 'Body', host: activity, list: false, activities: own });
  }
  for (const prop of elements(activity).filter(isPropertyElement)) {
    const label = prop.localName.slice(prop.localName.lastIndexOf('.') + 1);
    const action = actionOf(prop);
    const catches = elements(prop).filter((c) => c.localName === 'Catch');
    if (catches.length || label === 'Catches') {
      for (const c of catches) {
        const a = actionOf(c);
        const type = friendlyType(c.getAttributeNS(NS.x, 'TypeArguments'));
        slots.push({ label: `Catch ${type}`, host: a ?? c, list: false, activities: a ? activityChildren(a) : [], catchType: type, argument: a ? delegateArgument(a) : undefined });
      }
      continue;
    }
    if (action) {
      slots.push({ label, host: action, list: false, activities: activityChildren(action), argument: delegateArgument(action) });
      continue;
    }
    if (SLOT_PROPS.has(label)) slots.push({ label, host: prop, list: label === 'Activities' || label === 'Branches' || label === 'Nodes', activities: activityChildren(prop) });
  }
  // keep content-property bodies (While, DoWhile…) after their condition-less property slots
  return slots.filter((s, i) => slots.findIndex((o) => o.host === s.host) === i);
}

/** Activities whose body is their content (a single activity, not a property element). */
const CONTENT_BODY = new Set(['While', 'DoWhile', 'ui:RetryScope', 'NoPersistScope', 'CancellationScope', 'TransactionScope', 'Persist']);

/** The activity, slot and position an activity sits in, or null for the top activity. */
export function placeOf(activity: Element): { parent: Element; slot: Slot; index: number } | null {
  let p: Element | null = activity.parentElement;
  while (p && !isActivity(p)) p = p.parentElement;
  if (!p || p.localName === 'Activity') return null;
  for (const slot of slotsOf(p)) {
    const index = slot.activities.indexOf(activity);
    if (index >= 0) return { parent: p, slot, index };
  }
  return null;
}

// ── showing an activity ──────────────────────────────────────────────────────
/** "ReadCsvFile" → "Read Csv File" (UiPath's own names where known). */
export function typeLabel(el: Element): string {
  const known = TYPE_LABELS[el.localName];
  if (known) return known;
  return el.localName.replace(/`\d+$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

const TYPE_LABELS: Record<string, string> = {
  ReadCsvFile: 'Read CSV',
  WriteCsvFile: 'Write CSV',
  TypeInto: 'Type Into',
  GetValue: 'Get Text',
  SetValue: 'Set Text',
  ForEachRow: 'For Each Row',
  ForEach: 'For Each',
  TryCatch: 'Try Catch',
  DoWhile: 'Do While',
  ExcelApplicationScope: 'Excel Application Scope',
  ExcelWriteRange: 'Write Range',
  ExcelReadRange: 'Read Range',
  OpenBrowser: 'Open Browser',
  CloseTab: 'Close Tab',
  InvokeWorkflowFile: 'Invoke Workflow File',
  LogMessage: 'Log Message',
  MessageBox: 'Message Box',
  WriteLine: 'Write Line',
};

export function displayName(el: Element): string {
  return el.getAttribute('DisplayName') || typeLabel(el);
}

/** "{x:Null}" and friends: no value. */
export const isNullValue = (v: string | null | undefined) => !v || v === '{x:Null}';

/** A VisualBasicValue / CSharpValue element (an expression written as an element). */
const isExpressionElement = (el: Element) => /^(VisualBasic|CSharp)(Value|Reference)$/.test(el.localName);

/** The expression element a property element or argument holds, if it is written that way. */
function expressionElement(el: Element): Element | null {
  const direct = elements(el).find(isExpressionElement);
  if (direct) return direct;
  const arg = elements(el).find((c) => /^(In|Out|InOut)Argument$/.test(c.localName));
  return arg ? (elements(arg).find(isExpressionElement) ?? null) : null;
}

/** The expression of a property set as an element (<Assign.To><OutArgument>[x]</OutArgument>, <While.Condition><VisualBasicValue …/>). */
export function argumentText(activity: Element, prop: string): string | null {
  const pe = elements(activity).find((c) => c.localName === `${activity.localName}.${prop}`);
  if (!pe) return null;
  const expr = expressionElement(pe);
  if (expr) return `[${expr.getAttribute('ExpressionText') ?? ''}]`;
  const arg = elements(pe).find((c) => /^(In|Out|InOut)Argument$/.test(c.localName));
  return arg ? (arg.textContent ?? '').trim() : null;
}

/** The selector of a UI activity's target (Click, Type Into…). */
export function selectorOf(activity: Element): string | null {
  for (const pe of elements(activity).filter((c) => c.localName.endsWith('.Target'))) {
    const t = elements(pe).find((c) => c.localName === 'Target');
    const s = t?.getAttribute('Selector');
    if (s && !isNullValue(s)) return s;
  }
  return null;
}

/** A short line describing what an activity does, shown on its card. */
export function summaryOf(el: Element): string {
  const a = (n: string) => {
    const v = el.getAttribute(n);
    return isNullValue(v) ? null : v!;
  };
  switch (el.localName) {
    case 'Assign': {
      const to = argumentText(el, 'To');
      const value = argumentText(el, 'Value');
      return to || value ? `${to || '…'} = ${value || '…'}` : '';
    }
    case 'If':
    case 'While':
    case 'DoWhile':
      return a('Condition') ? `Condition: ${a('Condition')}` : argumentText(el, 'Condition') ? `Condition: ${argumentText(el, 'Condition')}` : '';
    case 'ForEach':
    case 'ParallelForEach':
      return a('Values') ? `In ${a('Values')}` : '';
    case 'ForEachRow':
      return a('DataTable') ? `Each row in ${a('DataTable')}` : '';
    case 'ReadCsvFile':
    case 'WriteCsvFile':
      return [a('FilePath'), a('DataTable') && `→ ${a('DataTable')}`].filter(Boolean).join(' ');
    case 'TypeInto':
      return a('Text') ? `Text: ${a('Text')}` : selectorOf(el) ?? '';
    case 'LogMessage':
      return [a('Level'), a('Message')].filter(Boolean).join(': ');
    case 'MessageBox':
    case 'WriteLine':
    case 'Comment':
      return a('Text') ?? '';
    case 'InvokeWorkflowFile':
      return a('WorkflowFileName') ?? '';
    case 'OpenBrowser':
      return a('Url') ?? '';
    case 'Delay':
      return a('Duration') ?? '';
    case 'ExcelApplicationScope':
      return a('WorkbookPath') ?? '';
    case 'ExcelWriteRange':
    case 'ExcelReadRange':
      return [a('SheetName'), a('StartingCell') ?? a('Range'), a('DataTable')].filter(Boolean).join(' · ');
    default:
      return selectorOf(el) ?? '';
  }
}

/** What kind of icon / colour an activity gets. */
export function categoryOf(el: Element): 'container' | 'control' | 'ui' | 'data' | 'system' | 'error' | 'other' {
  const n = el.localName;
  if (LIST_CONTAINERS.has(n) || /Scope$/.test(n)) return 'container';
  if (['If', 'While', 'DoWhile', 'ForEach', 'ForEachRow', 'ParallelForEach', 'Switch', 'Break', 'Continue', 'Pick'].includes(n)) return 'control';
  if (['TryCatch', 'Throw', 'Rethrow', 'Retry', 'RetryScope', 'TerminateWorkflow'].includes(n)) return 'error';
  if (el.namespaceURI === NS.ui && (selectorOf(el) || /Click|Type|Text|Browser|Tab|Hover|Element|Window|Navigate|Keys/.test(n))) return 'ui';
  if (/Csv|Excel|Range|DataTable|Row|Assign|File|Json|Xml/.test(n)) return 'data';
  if (/Log|Message|Delay|Invoke|WriteLine|Comment/.test(n)) return 'system';
  return 'other';
}

// ── properties ───────────────────────────────────────────────────────────────
/** One editable property of an activity, shown in the Properties panel. */
export interface PropertyRef {
  /** "DisplayName", "Condition", "To", "Target.Selector" */
  name: string;
  value: string;
  /** an expression ([..]) or plain text; argument elements always hold expressions */
  kind: 'attribute' | 'argument' | 'target' | 'expression';
  /** for arguments: In / Out / InOut and the type */
  hint?: string;
}

const HIDDEN_ATTRS = /^(xmlns|sap|sap2010|mc|x:Class|mva:|x:Key)/;

export function propertiesOf(el: Element): PropertyRef[] {
  const out: PropertyRef[] = [{ name: 'DisplayName', value: el.getAttribute('DisplayName') ?? '', kind: 'attribute' }];
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === 'DisplayName' || HIDDEN_ATTRS.test(attr.name)) continue;
    out.push({ name: attr.name, value: isNullValue(attr.value) ? '' : attr.value, kind: 'attribute' });
  }
  for (const pe of elements(el).filter(isPropertyElement)) {
    const prop = pe.localName.slice(pe.localName.lastIndexOf('.') + 1);
    if (!pe.localName.startsWith(`${el.localName}.`)) continue;
    const expr = expressionElement(pe);
    if (expr) {
      // shown and edited in brackets, like the other expressions; stored without them
      out.push({ name: prop, value: `[${expr.getAttribute('ExpressionText') ?? ''}]`, kind: 'expression', hint: friendlyType(expr.getAttributeNS(NS.x, 'TypeArguments')) });
      continue;
    }
    const arg = elements(pe).find((c) => /^(In|Out|InOut)Argument$/.test(c.localName));
    if (arg && elements(arg).length === 0) {
      out.push({ name: prop, value: (arg.textContent ?? '').trim(), kind: 'argument', hint: `${arg.localName.replace('Argument', '')} · ${friendlyType(arg.getAttributeNS(NS.x, 'TypeArguments'))}` });
      continue;
    }
    const target = elements(pe).find((c) => c.localName === 'Target');
    if (target) {
      for (const attr of Array.from(target.attributes)) {
        if (HIDDEN_ATTRS.test(attr.name)) continue;
        out.push({ name: `${prop}.${attr.name}`, value: isNullValue(attr.value) ? '' : attr.value, kind: 'target' });
      }
    }
  }
  const note = el.getAttributeNS(NS.sap2010, 'Annotation.AnnotationText');
  out.push({ name: 'Annotation', value: note ?? '', kind: 'attribute' });
  return out;
}

/** Sets a property found by propertiesOf. An empty value becomes {x:Null} where it was null. */
export function setProperty(el: Element, ref: Pick<PropertyRef, 'name' | 'kind'>, value: string): void {
  if (ref.name === 'Annotation') {
    if (value) setNsAttr(el, 'sap2010', 'Annotation.AnnotationText', value);
    else el.removeAttributeNS(NS.sap2010, 'Annotation.AnnotationText');
    return;
  }
  if (ref.kind === 'attribute') {
    if (ref.name === 'DisplayName' && !value) el.removeAttribute('DisplayName');
    else el.setAttribute(ref.name, value === '' && isNullValue(el.getAttribute(ref.name)) && el.hasAttribute(ref.name) ? '{x:Null}' : value);
    return;
  }
  if (ref.kind === 'expression') {
    const pe = elements(el).find((c) => c.localName === `${el.localName}.${ref.name}`);
    const expr = pe && expressionElement(pe);
    if (expr) expr.setAttribute('ExpressionText', value.replace(/^\[([\s\S]*)\]$/, '$1'));
    return;
  }
  if (ref.kind === 'argument') {
    const pe = elements(el).find((c) => c.localName === `${el.localName}.${ref.name}`);
    const arg = pe && elements(pe).find((c) => /^(In|Out|InOut)Argument$/.test(c.localName));
    if (arg) arg.textContent = value;
    return;
  }
  const [prop, attr] = ref.name.split('.');
  const pe = elements(el).find((c) => c.localName === `${el.localName}.${prop}`);
  const target = pe && elements(pe).find((c) => c.localName === 'Target');
  if (target) target.setAttribute(attr, value === '' ? '{x:Null}' : value);
}

/** Sets a prefixed attribute (sap2010:Annotation.AnnotationText), declaring the prefix if needed. */
function setNsAttr(el: Element, prefix: keyof typeof NS, local: string, value: string) {
  const root = el.ownerDocument.documentElement;
  const uri = NS[prefix];
  const p = root.lookupPrefix(uri) ?? prefix;
  if (!root.lookupPrefix(uri)) root.setAttributeNS(NS.xmlns, `xmlns:${p}`, uri);
  el.setAttributeNS(uri, `${p}:${local}`, value);
}

// ── variables and arguments ──────────────────────────────────────────────────
export interface VariableInfo {
  el: Element;
  name: string;
  type: string;
  /** the default value (attribute or Variable.Default) */
  value: string;
  /** the activity declaring it */
  scope: Element;
}

export function variablesOf(scope: Element): VariableInfo[] {
  const holder = elements(scope).find((c) => c.localName === `${scope.localName}.Variables`);
  if (!holder) return [];
  return elements(holder)
    .filter((v) => v.localName === 'Variable')
    .map((v) => ({
      el: v,
      name: v.getAttribute('Name') ?? '',
      type: v.getAttributeNS(NS.x, 'TypeArguments') ?? '',
      value: v.getAttribute('Default') ?? elements(v).find((c) => c.localName === 'Variable.Default')?.textContent?.trim() ?? '',
      scope,
    }));
}

/** Variables in scope at `el`: its own and its ancestors', nearest first. */
export function variablesInScope(el: Element | null, main: Element | null): VariableInfo[] {
  const out: VariableInfo[] = [];
  for (let p: Element | null = el ?? main; p && p.localName !== 'Activity'; p = p.parentElement) {
    if (isActivity(p)) out.push(...variablesOf(p));
  }
  return out;
}

/** The nearest activity at or above `el` that can declare variables. */
export function variableScopeFor(el: Element | null, main: Element | null): Element | null {
  for (let p: Element | null = el ?? main; p && p.localName !== 'Activity'; p = p.parentElement) {
    if (isActivity(p) && VARIABLE_SCOPES.has(p.localName)) return p;
  }
  return main && VARIABLE_SCOPES.has(main.localName) ? main : null;
}

export function addVariable(scope: Element, name: string, type: string): Element {
  const doc = scope.ownerDocument;
  let holder = elements(scope).find((c) => c.localName === `${scope.localName}.Variables`);
  if (!holder) {
    holder = doc.createElementNS(scope.namespaceURI, `${scope.prefix ? `${scope.prefix}:` : ''}${scope.localName}.Variables`);
    // variables go first, as Studio writes them
    insertChild(scope, holder, elements(scope)[0] ?? null);
  }
  ensureTypePrefix(scope.ownerDocument.documentElement, type);
  const v = doc.createElementNS(NS.activities, `${activitiesPrefix(doc)}Variable`);
  v.setAttributeNS(NS.x, `${prefixFor(doc, NS.x)}:TypeArguments`, type);
  v.setAttribute('Name', name);
  insertChild(holder, v, null);
  return v;
}

export function updateVariable(v: Element, change: { name?: string; type?: string; value?: string }): void {
  if (change.name !== undefined) v.setAttribute('Name', change.name);
  if (change.type !== undefined) {
    ensureTypePrefix(v.ownerDocument.documentElement, change.type);
    v.setAttributeNS(NS.x, `${prefixFor(v.ownerDocument, NS.x)}:TypeArguments`, change.type);
  }
  if (change.value !== undefined) {
    const child = elements(v).find((c) => c.localName === 'Variable.Default');
    if (child) removeNode(child);
    if (change.value) v.setAttribute('Default', change.value);
    else v.removeAttribute('Default');
  }
}

export interface ArgumentInfo {
  el: Element;
  name: string;
  direction: 'In' | 'Out' | 'InOut' | 'Property';
  type: string;
}

function membersOf(root: Element): Element | null {
  return elements(root).find((c) => c.namespaceURI === NS.x && c.localName === 'Members') ?? null;
}

export function argumentsOf(root: Element): ArgumentInfo[] {
  const members = membersOf(root);
  if (!members) return [];
  return elements(members)
    .filter((p) => p.localName === 'Property')
    .map((p) => {
      const t = p.getAttribute('Type') ?? '';
      const m = /^(InOut|In|Out)Argument\((.*)\)$/.exec(t);
      return { el: p, name: p.getAttribute('Name') ?? '', direction: (m?.[1] as ArgumentInfo['direction']) ?? 'Property', type: m ? m[2] : t };
    });
}

export function addArgument(root: Element, name: string, direction: 'In' | 'Out' | 'InOut', type: string): Element {
  const doc = root.ownerDocument;
  let members = membersOf(root);
  const x = prefixFor(doc, NS.x);
  if (!members) {
    members = doc.createElementNS(NS.x, `${x}:Members`);
    insertChild(root, members, elements(root)[0] ?? null);
  }
  ensureTypePrefix(root, type);
  const p = doc.createElementNS(NS.x, `${x}:Property`);
  p.setAttribute('Name', name);
  p.setAttribute('Type', `${direction}Argument(${type})`);
  insertChild(members, p, null);
  return p;
}

export function updateArgument(p: Element, change: { name?: string; direction?: 'In' | 'Out' | 'InOut'; type?: string }): void {
  const cur = /^(InOut|In|Out)Argument\((.*)\)$/.exec(p.getAttribute('Type') ?? '');
  if (change.name !== undefined) p.setAttribute('Name', change.name);
  if (change.direction !== undefined || change.type !== undefined) {
    const type = change.type ?? cur?.[2] ?? 'x:String';
    ensureTypePrefix(p.ownerDocument.documentElement, type);
    p.setAttribute('Type', `${change.direction ?? cur?.[1] ?? 'In'}Argument(${type})`);
  }
}

/** Namespaces imported for expressions (TextExpression.NamespacesForImplementation). */
export function importsOf(root: Element): Element[] {
  const holder = elements(root).find((c) => c.localName === 'TextExpression.NamespacesForImplementation');
  const list = holder ? elements(holder)[0] : undefined;
  return list ? elements(list).filter((c) => c.localName === 'String') : [];
}

export function addImport(root: Element, ns: string): void {
  const holder = elements(root).find((c) => c.localName === 'TextExpression.NamespacesForImplementation');
  const list = holder ? elements(holder)[0] : undefined;
  if (!list) throw new Error('This workflow has no list of imports to add to.');
  if (importsOf(root).some((e) => e.textContent === ns)) return;
  const doc = root.ownerDocument;
  const s = doc.createElementNS(NS.x, `${prefixFor(doc, NS.x)}:String`);
  s.textContent = ns;
  insertChild(list, s, null);
  const cap = list.getAttribute('Capacity');
  if (cap && Number(cap) < importsOf(root).length) list.setAttribute('Capacity', String(importsOf(root).length));
}

// ── changing the tree ────────────────────────────────────────────────────────
function activitiesPrefix(doc: Document): string {
  const p = doc.documentElement.lookupPrefix(NS.activities);
  return p ? `${p}:` : '';
}

function prefixFor(doc: Document, uri: string): string {
  const p = doc.documentElement.lookupPrefix(uri);
  if (p) return p;
  const wanted = Object.entries(KNOWN_PREFIXES).find(([, u]) => u === uri)?.[0] ?? 'ns';
  let name = wanted;
  for (let i = 2; doc.documentElement.lookupNamespaceURI(name); i++) name = `${wanted}${i}`;
  doc.documentElement.setAttributeNS(NS.xmlns, `xmlns:${name}`, uri);
  return name;
}

/** Declares the prefixes a type such as "scg:List(sd:DataRow)" uses, when they are known ones. */
export function ensureTypePrefix(root: Element, type: string): void {
  for (const m of type.matchAll(/\b([a-z][a-z0-9]*):/gi)) {
    const prefix = m[1];
    if (!root.lookupNamespaceURI(prefix) && KNOWN_PREFIXES[prefix]) root.setAttributeNS(NS.xmlns, `xmlns:${prefix}`, KNOWN_PREFIXES[prefix]);
  }
}

/** The whitespace a child of `parent` is indented with (from the file, or the parent's + 2). */
function indentOf(parent: Element): string {
  for (const c of Array.from(parent.childNodes)) {
    if (c.nodeType === 3 && /\n([ \t]*)$/.test(c.textContent ?? '') && c.nextSibling?.nodeType === 1) return /\n([ \t]*)$/.exec(c.textContent!)![1];
  }
  return ownIndent(parent) + '  ';
}

function ownIndent(el: Element): string {
  const prev = el.previousSibling;
  if (prev?.nodeType === 3) {
    const m = /\n([ \t]*)$/.exec(prev.textContent ?? '');
    if (m) return m[1];
  }
  return el.parentElement ? ownIndent(el.parentElement) + '  ' : '';
}

/** Indents a new element's insides, as Studio would write them. */
function indentTree(el: Element, indent: string) {
  const kids = elements(el);
  if (!kids.length) return;
  for (const t of Array.from(el.childNodes)) if (t.nodeType === 3 && !(t.textContent ?? '').trim()) el.removeChild(t);
  for (const k of kids) {
    el.insertBefore(el.ownerDocument.createTextNode(`\n${indent}  `), k);
    indentTree(k, `${indent}  `);
  }
  el.appendChild(el.ownerDocument.createTextNode(`\n${indent}`));
}

/** Inserts `child` into `parent` before `before` (null: at the end), with the file's indentation. */
export function insertChild(parent: Element, child: Element, before: Element | null): void {
  const indent = indentOf(parent);
  const doc = parent.ownerDocument;
  const hadElements = elements(parent).length > 0;
  if (!hadElements) {
    // <Sequence /> → <Sequence>…</Sequence>
    for (const t of Array.from(parent.childNodes)) if (t.nodeType === 3 && !(t.textContent ?? '').trim()) parent.removeChild(t);
    parent.appendChild(doc.createTextNode(`\n${indent}`));
    parent.appendChild(child);
    parent.appendChild(doc.createTextNode(`\n${ownIndent(parent)}`));
  } else if (before) {
    parent.insertBefore(child, before);
    parent.insertBefore(doc.createTextNode(`\n${indent}`), before);
  } else {
    const last = elements(parent).at(-1)!;
    parent.insertBefore(doc.createTextNode(`\n${indent}`), last.nextSibling);
    parent.insertBefore(child, last.nextSibling!.nextSibling);
  }
  indentTree(child, indent);
}

/** Removes an element together with the line it was on. */
export function removeNode(el: Element): void {
  const parent = el.parentNode!;
  const prev = el.previousSibling;
  if (prev?.nodeType === 3 && /\n[ \t]*$/.test(prev.textContent ?? '')) {
    prev.textContent = (prev.textContent ?? '').replace(/\n[ \t]*$/, '');
    if (!prev.textContent) parent.removeChild(prev);
  }
  parent.removeChild(el);
  if (parent.nodeType === 1 && !elements(parent as Element).length) {
    for (const t of Array.from(parent.childNodes)) if (t.nodeType === 3 && !(t.textContent ?? '').trim()) parent.removeChild(t);
  }
}

/** New activity elements from a XAML snippet written with the usual prefixes (ui:, x:, s:, sd:…). */
export function fromSnippet(doc: XMLDocument, snippet: string): Element {
  const root = doc.documentElement;
  // declare what the snippet uses, on the workflow's root, and read it with the same declarations
  for (const m of snippet.matchAll(/[<\s"(]([a-z][a-z0-9]*):[A-Za-z]/g)) {
    const prefix = m[1];
    if (!root.lookupNamespaceURI(prefix) && KNOWN_PREFIXES[prefix]) root.setAttributeNS(NS.xmlns, `xmlns:${prefix}`, KNOWN_PREFIXES[prefix]);
  }
  const decls = Array.from(root.attributes)
    .filter((a) => a.name === 'xmlns' || a.name.startsWith('xmlns:'))
    .map((a) => `${a.name}="${escapeAttr(a.value)}"`)
    .join(' ');
  const wrapped = new DOMParser().parseFromString(`<fe-wrap ${decls}>${snippet}</fe-wrap>`, 'application/xml');
  const err = wrapped.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`Activity template error: ${err.textContent}`);
  const el = elements(wrapped.documentElement)[0];
  return doc.importNode(el, true) as Element;
}

/** Copies an activity for Duplicate / paste, without the designer ids Studio keeps unique. */
export function cloneActivity(el: Element): Element {
  const copy = el.cloneNode(true) as Element;
  const strip = (e: Element) => {
    e.removeAttributeNS(NS.sap2010, 'WorkflowViewState.IdRef');
    elements(e).forEach(strip);
  };
  strip(copy);
  return copy;
}

/**
 * Puts `activity` into `slot` at `index` (it is moved if it is already in the tree; `index` counts
 * the slot's activities without it). A slot that
 * holds one activity and already has one gets a Sequence around both, as Studio does.
 */
export function placeActivity(activity: Element, slot: Slot, index: number): void {
  if (activity.contains(slot.host)) throw new Error("An activity can't be moved into itself.");
  const current = slot.activities.filter((a) => a !== activity);
  if (activity.parentNode) removeNode(activity);
  if (!slot.list && current.length) {
    const only = current[0];
    if (only.localName === 'Sequence') {
      const inner = activityChildren(only);
      const at = Math.max(0, Math.min(index, inner.length));
      insertChild(only, activity, inner[at] ?? null);
      return;
    }
    const doc = slot.host.ownerDocument as XMLDocument;
    const seq = doc.createElementNS(NS.activities, `${activitiesPrefix(doc)}Sequence`);
    seq.setAttribute('DisplayName', slot.label || 'Body');
    const after = only.nextSibling;
    removeNode(only);
    insertChild(slot.host, seq, after && after.parentNode === slot.host ? firstElementFrom(after) : null);
    insertChild(seq, index === 0 ? activity : only, null);
    insertChild(seq, index === 0 ? only : activity, null);
    return;
  }
  const siblings = slot.list ? current : [];
  const before = siblings[index] ?? null;
  // a content slot's activities follow its property elements (Variables, ViewState…)
  if (!before && slot.host.localName !== 'ActivityAction') {
    insertChild(slot.host, activity, null);
    return;
  }
  insertChild(slot.host, activity, before);
}

function firstElementFrom(n: Node | null): Element | null {
  for (let c = n; c; c = c.nextSibling) if (c.nodeType === 1) return c as Element;
  return null;
}

// ── writing ──────────────────────────────────────────────────────────────────
const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function write(node: Node, out: string[], eol: string) {
  switch (node.nodeType) {
    case 1: {
      const el = node as Element;
      out.push('<', el.nodeName);
      for (const a of Array.from(el.attributes)) out.push(' ', a.name, '="', escapeAttr(a.value), '"');
      if (!el.childNodes.length) {
        out.push(' />');
        return;
      }
      out.push('>');
      for (const c of Array.from(el.childNodes)) write(c, out, eol);
      out.push('</', el.nodeName, '>');
      return;
    }
    case 3:
      out.push(eol === '\n' ? escapeText(node.textContent ?? '') : escapeText(node.textContent ?? '').replace(/\n/g, eol));
      return;
    case 4:
      out.push('<![CDATA[', node.textContent ?? '', ']]>');
      return;
    case 7:
      out.push('<?', (node as ProcessingInstruction).target, ' ', (node as ProcessingInstruction).data, '?>');
      return;
    case 8:
      out.push('<!--', node.textContent ?? '', '-->');
      return;
  }
}

/** The workflow as text again. */
export function serializeXaml(w: ParsedWorkflow): string {
  const out: string[] = [];
  write(w.root, out, w.eol);
  // anything after the root (comments; the parser drops whitespace there, so a final newline is
  // kept from the original text by the caller's prolog / epilog)
  for (let n = w.root.nextSibling; n; n = n.nextSibling) write(n, out, w.eol);
  return (w.bom ? '\ufeff' : '') + w.prolog + out.join('') + w.epilog;
}
