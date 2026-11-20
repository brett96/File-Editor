// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ACTIVITY_TEMPLATES, BLANK_WORKFLOW } from '../src/core/workflow/activities';
import {
  addArgument,
  addImport,
  addVariable,
  argumentsOf,
  cloneActivity,
  displayName,
  fromSnippet,
  importsOf,
  isWorkflowXaml,
  parseXaml,
  placeActivity,
  placeOf,
  propertiesOf,
  removeNode,
  serializeXaml,
  setProperty,
  slotsOf,
  summaryOf,
  updateVariable,
  variablesInScope,
} from '../src/core/workflow/xaml';

// A small UiPath-style workflow: CRLF line endings, a selector with a line break (&#xA;), an
// expression written as an element, a Try Catch and a For Each Row.
const XAML = [
  '<Activity mc:Ignorable="sap sap2010" x:Class="Demo" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:mva="clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities" xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation" xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation" xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">',
  '  <x:Members>',
  '    <x:Property Name="in_File" Type="InArgument(x:String)" />',
  '  </x:Members>',
  '  <TextExpression.NamespacesForImplementation>',
  '    <scg:List x:TypeArguments="x:String" Capacity="2">',
  '      <x:String>System</x:String>',
  '      <x:String>UiPath.Core</x:String>',
  '    </scg:List>',
  '  </TextExpression.NamespacesForImplementation>',
  '  <Sequence DisplayName="Main" sap2010:WorkflowViewState.IdRef="Sequence_1">',
  '    <Sequence.Variables>',
  '      <Variable x:TypeArguments="x:Int32" Name="count" />',
  '    </Sequence.Variables>',
  '    <Assign sap2010:WorkflowViewState.IdRef="Assign_1">',
  '      <Assign.To>',
  '        <OutArgument x:TypeArguments="x:Int32">[count]</OutArgument>',
  '      </Assign.To>',
  '      <Assign.Value>',
  '        <InArgument x:TypeArguments="x:Int32">0</InArgument>',
  '      </Assign.Value>',
  '    </Assign>',
  '    <While DisplayName="Loop" sap2010:WorkflowViewState.IdRef="While_1">',
  '      <While.Condition>',
  '        <mva:VisualBasicValue x:TypeArguments="x:Boolean" ExpressionText="count &lt; 3" />',
  '      </While.Condition>',
  '      <ui:Click DisplayName="Click OK" sap2010:WorkflowViewState.IdRef="Click_1">',
  '        <ui:Click.Target>',
  '          <ui:Target Selector="&lt;wnd app=\'x.exe\' /&gt;&#xA;&lt;ctrl name=\'OK\' /&gt;" WaitForReady="INTERACTIVE" />',
  '        </ui:Click.Target>',
  '      </ui:Click>',
  '    </While>',
  '    <If Condition="[count = 3]" DisplayName="Done?">',
  '      <If.Then>',
  '        <ui:LogMessage DisplayName="Log" Level="Info" Message="[&quot;done&quot;]" />',
  '      </If.Then>',
  '    </If>',
  '  </Sequence>',
  '</Activity>',
  '',
].join('\r\n');

const main = (w: ReturnType<typeof parseXaml>) => w.main!;
const kids = (el: Element) => slotsOf(el)[0].activities;

describe('workflow xaml', () => {
  it('knows workflows from other XAML', () => {
    expect(isWorkflowXaml(XAML)).toBe(true);
    expect(isWorkflowXaml('<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" />')).toBe(false);
  });

  it('writes an unchanged workflow back byte for byte (CRLF, &#xA; in selectors)', () => {
    expect(serializeXaml(parseXaml(XAML))).toBe(XAML);
    expect(serializeXaml(parseXaml(`﻿<?xml version="1.0"?>\n${BLANK_WORKFLOW}`))).toBe(`﻿<?xml version="1.0"?>\n${BLANK_WORKFLOW}`);
  });

  it('reads the activities, their slots and summaries', () => {
    const w = parseXaml(XAML);
    expect(displayName(main(w))).toBe('Main');
    expect(kids(main(w)).map(displayName)).toEqual(['Assign', 'Loop', 'Done?']);
    const [assign, loop, iff] = kids(main(w));
    expect(summaryOf(assign)).toBe('[count] = 0');
    expect(summaryOf(loop)).toBe('Condition: [count < 3]');
    expect(slotsOf(loop).map((s) => [s.label, s.activities.map(displayName)])).toEqual([['Body', ['Click OK']]]);
    expect(summaryOf(slotsOf(loop)[0].activities[0])).toBe("<wnd app='x.exe' />\n<ctrl name='OK' />");
    expect(slotsOf(iff).map((s) => s.label)).toEqual(['Then']);
    expect(placeOf(assign)).toMatchObject({ parent: main(w), index: 0 });
  });

  it('edits properties: attributes, arguments, expression elements and selectors', () => {
    const w = parseXaml(XAML);
    const [assign, loop] = kids(main(w));
    const props = propertiesOf(assign);
    expect(props.map((p) => [p.name, p.value, p.kind])).toEqual([
      ['DisplayName', '', 'attribute'],
      ['To', '[count]', 'argument'],
      ['Value', '0', 'argument'],
      ['Annotation', '', 'attribute'],
    ]);
    setProperty(assign, { name: 'Value', kind: 'argument' }, '[count + 1]');
    setProperty(assign, { name: 'DisplayName', kind: 'attribute' }, 'Next');
    setProperty(loop, { name: 'Condition', kind: 'expression' }, '[count < 10]');
    const click = slotsOf(loop)[0].activities[0];
    setProperty(click, { name: 'Target.Selector', kind: 'target' }, "<wnd app='y.exe' />\n<ctrl name='Go' />");
    setProperty(click, { name: 'Annotation', kind: 'attribute' }, 'Waits for the window');
    const out = serializeXaml(w);
    expect(out).toContain('<Assign sap2010:WorkflowViewState.IdRef="Assign_1" DisplayName="Next">');
    expect(out).toContain('<InArgument x:TypeArguments="x:Int32">[count + 1]</InArgument>');
    expect(out).toContain('ExpressionText="count &lt; 10"');
    expect(out).toContain('Selector="&lt;wnd app=\'y.exe\' /&gt;&#xA;&lt;ctrl name=\'Go\' /&gt;"');
    expect(out).toContain('sap2010:Annotation.AnnotationText="Waits for the window"');
    // still a valid workflow, with the same activities
    expect(kids(main(parseXaml(out))).map(displayName)).toEqual(['Next', 'Loop', 'Done?']);
  });

  it('adds activities from the palette, indented like their neighbours', () => {
    const w = parseXaml(XAML);
    const log = fromSnippet(w.doc, ACTIVITY_TEMPLATES.find((t) => t.id === 'log')!.xaml);
    placeActivity(log, slotsOf(main(w))[0], 1);
    const out = serializeXaml(w);
    expect(kids(main(parseXaml(out))).map(displayName)).toEqual(['Assign', 'Log Message', 'Loop', 'Done?']);
    expect(out).toContain('    </Assign>\r\n    <ui:LogMessage DisplayName="Log Message" Level="Info" Message="[&quot;&quot;]" />\r\n    <While');
    // every template is valid XAML in this file, declaring the prefixes it needs (s:, sd:)
    for (const t of ACTIVITY_TEMPLATES) {
      const el = fromSnippet(w.doc, t.xaml);
      placeActivity(el, slotsOf(main(w))[0], 0);
    }
    const all = serializeXaml(w);
    expect(all).toContain('xmlns:sd="clr-namespace:System.Data;assembly=System.Data"');
    expect(all).toContain('xmlns:s="clr-namespace:System;assembly=mscorlib"');
    const again = parseXaml(all);
    expect(kids(main(again))).toHaveLength(ACTIVITY_TEMPLATES.length + 4);
    // nested templates are indented too
    expect(all).toMatch(/\r\n {6}<If\.Then>\r\n {8}<Sequence DisplayName="Then" \/>\r\n {6}<\/If\.Then>/);
  });

  it('wraps a second activity in a Sequence where only one fits (If.Then)', () => {
    const w = parseXaml(XAML);
    const iff = kids(main(w))[2];
    const then = slotsOf(iff)[0];
    placeActivity(fromSnippet(w.doc, '<Delay Duration="00:00:01" DisplayName="Wait" />'), then, 1);
    const inner = slotsOf(iff)[0].activities;
    expect(inner.map((e) => e.localName)).toEqual(['Sequence']);
    expect(kids(inner[0]).map(displayName)).toEqual(['Log', 'Wait']);
    expect(() => parseXaml(serializeXaml(w))).not.toThrow();
  });

  it('moves, duplicates and deletes', () => {
    const w = parseXaml(XAML);
    const [assign, loop] = kids(main(w));
    // the index counts the list without the activity being moved
    placeActivity(assign, slotsOf(main(w))[0], 1);
    expect(kids(main(w)).map(displayName)).toEqual(['Loop', 'Assign', 'Done?']);
    // into another container: the While's body gets a Sequence around both
    placeActivity(assign, slotsOf(loop)[0], 0);
    expect(kids(main(w)).map(displayName)).toEqual(['Loop', 'Done?']);
    expect(kids(slotsOf(loop)[0].activities[0]).map(displayName)).toEqual(['Assign', 'Click OK']);
    expect(() => placeActivity(loop, slotsOf(loop)[0], 0)).toThrow(/into itself/);
    const copy = cloneActivity(kids(main(w))[1]);
    expect(copy.getAttributeNS('http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation', 'WorkflowViewState.IdRef')).toBeNull();
    placeActivity(copy, slotsOf(main(w))[0], 2);
    removeNode(loop);
    expect(kids(main(w)).map(displayName)).toEqual(['Done?', 'Done?']);
    const out = serializeXaml(w);
    expect(out).not.toMatch(/\r\n\s*\r\n/); // no blank lines left behind
    expect(kids(main(parseXaml(out))).map(displayName)).toEqual(['Done?', 'Done?']);
  });

  it('edits variables, arguments and imports', () => {
    const w = parseXaml(XAML);
    const loop = kids(main(w))[1];
    const click = slotsOf(loop)[0].activities[0];
    expect(variablesInScope(click, main(w)).map((v) => [v.name, v.type, v.scope.getAttribute('DisplayName')])).toEqual([['count', 'x:Int32', 'Main']]);
    const v = addVariable(main(w), 'table', 'sd:DataTable');
    updateVariable(v, { value: '[New DataTable]' });
    updateVariable(variablesInScope(click, main(w))[0].el, { name: 'total' });
    addArgument(w.root, 'out_Result', 'Out', 'x:Boolean');
    addImport(w.root, 'System.Data');
    const out = serializeXaml(w);
    expect(out).toContain('<Variable x:TypeArguments="sd:DataTable" Name="table" Default="[New DataTable]" />');
    expect(out).toContain('xmlns:sd="clr-namespace:System.Data;assembly=System.Data"');
    const again = parseXaml(out);
    expect(variablesInScope(again.main, again.main).map((x) => x.name)).toEqual(['total', 'table']);
    expect(argumentsOf(again.root).map((a) => [a.name, a.direction, a.type])).toEqual([
      ['in_File', 'In', 'x:String'],
      ['out_Result', 'Out', 'x:Boolean'],
    ]);
    expect(importsOf(again.root).map((i) => i.textContent)).toEqual(['System', 'UiPath.Core', 'System.Data']);
    expect(out).toContain('Capacity="3"');
  });

  it('refuses text that is not a workflow', () => {
    expect(() => parseXaml('<Activity')).toThrow(/valid XML/);
    expect(() => parseXaml('<Window />')).toThrow(/not a workflow/);
  });
});
