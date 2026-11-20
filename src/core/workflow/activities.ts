/**
 * The activities the workflow designer can add, as XAML written the way UiPath Studio writes
 * them (with the usual prefixes: ui: for UiPath, x: for XAML types, s: / sd: for .NET types;
 * fromSnippet declares any the file doesn't have yet).
 */

export interface ActivityTemplate {
  id: string;
  name: string;
  group: 'Workflow' | 'Control' | 'Error handling' | 'UI Automation' | 'Data & files' | 'System';
  hint: string;
  xaml: string;
}

const seq = (name: string) => `<Sequence DisplayName="${name}" />`;

export const ACTIVITY_TEMPLATES: ActivityTemplate[] = [
  { id: 'sequence', name: 'Sequence', group: 'Workflow', hint: 'Activities run one after another', xaml: seq('Sequence') },
  {
    id: 'assign',
    name: 'Assign',
    group: 'Workflow',
    hint: 'Set a variable to a value',
    xaml: '<Assign DisplayName="Assign"><Assign.To><OutArgument x:TypeArguments="x:Object" /></Assign.To><Assign.Value><InArgument x:TypeArguments="x:Object" /></Assign.Value></Assign>',
  },
  { id: 'invoke', name: 'Invoke Workflow File', group: 'Workflow', hint: 'Run another .xaml workflow', xaml: '<ui:InvokeWorkflowFile DisplayName="Invoke Workflow File" WorkflowFileName="Workflow.xaml" />' },
  { id: 'comment', name: 'Comment', group: 'Workflow', hint: 'A note in the workflow', xaml: '<ui:Comment DisplayName="Comment" Text="" />' },
  {
    id: 'if',
    name: 'If',
    group: 'Control',
    hint: 'Then / Else on a condition',
    xaml: `<If Condition="[True]" DisplayName="If"><If.Then>${seq('Then')}</If.Then><If.Else>${seq('Else')}</If.Else></If>`,
  },
  { id: 'while', name: 'While', group: 'Control', hint: 'Repeat while a condition is true', xaml: `<While Condition="[False]" DisplayName="While">${seq('Body')}</While>` },
  { id: 'dowhile', name: 'Do While', group: 'Control', hint: 'Run, then repeat while a condition is true', xaml: `<DoWhile Condition="[False]" DisplayName="Do While">${seq('Body')}</DoWhile>` },
  {
    id: 'foreach',
    name: 'For Each',
    group: 'Control',
    hint: 'Run for each item of a collection',
    xaml: `<ForEach x:TypeArguments="x:Object" DisplayName="For Each" Values="[{}]"><ActivityAction x:TypeArguments="x:Object"><ActivityAction.Argument><DelegateInArgument x:TypeArguments="x:Object" Name="item" /></ActivityAction.Argument>${seq('Body')}</ActivityAction></ForEach>`,
  },
  {
    id: 'foreachrow',
    name: 'For Each Row',
    group: 'Control',
    hint: 'Run for each row of a DataTable',
    xaml: `<ui:ForEachRow DataTable="{x:Null}" DisplayName="For Each Row"><ui:ForEachRow.Body><ActivityAction x:TypeArguments="sd:DataRow"><ActivityAction.Argument><DelegateInArgument x:TypeArguments="sd:DataRow" Name="row" /></ActivityAction.Argument>${seq('Body')}</ActivityAction></ui:ForEachRow.Body></ui:ForEachRow>`,
  },
  { id: 'break', name: 'Break', group: 'Control', hint: 'Leave the loop', xaml: '<ui:Break DisplayName="Break" />' },
  { id: 'delay', name: 'Delay', group: 'Control', hint: 'Wait for a while', xaml: '<Delay Duration="00:00:01" DisplayName="Delay" />' },
  {
    id: 'trycatch',
    name: 'Try Catch',
    group: 'Error handling',
    hint: 'Handle errors',
    xaml: `<TryCatch DisplayName="Try Catch"><TryCatch.Try>${seq('Try')}</TryCatch.Try><TryCatch.Catches><Catch x:TypeArguments="s:Exception"><ActivityAction x:TypeArguments="s:Exception"><ActivityAction.Argument><DelegateInArgument x:TypeArguments="s:Exception" Name="exception" /></ActivityAction.Argument>${seq('Catch')}</ActivityAction></Catch></TryCatch.Catches></TryCatch>`,
  },
  { id: 'throw', name: 'Throw', group: 'Error handling', hint: 'Raise an error', xaml: '<Throw DisplayName="Throw" Exception="[New Exception(&quot;&quot;)]" />' },
  { id: 'rethrow', name: 'Rethrow', group: 'Error handling', hint: 'Raise the caught error again', xaml: '<Rethrow DisplayName="Rethrow" />' },
  {
    id: 'click',
    name: 'Click',
    group: 'UI Automation',
    hint: 'Click an element',
    xaml: '<ui:Click DelayBefore="{x:Null}" DelayMS="{x:Null}" ClickType="CLICK_SINGLE" DisplayName="Click" KeyModifiers="None" MouseButton="BTN_LEFT" SendWindowMessages="False" SimulateClick="True"><ui:Click.Target><ui:Target ClippingRegion="{x:Null}" Element="{x:Null}" Selector="" TimeoutMS="{x:Null}" WaitForReady="INTERACTIVE" /></ui:Click.Target></ui:Click>',
  },
  {
    id: 'typeinto',
    name: 'Type Into',
    group: 'UI Automation',
    hint: 'Type text into an element',
    xaml: '<ui:TypeInto DelayBefore="{x:Null}" DelayBetweenKeys="{x:Null}" DelayMS="{x:Null}" Activate="True" ClickBeforeTyping="True" DisplayName="Type Into" EmptyField="True" SendWindowMessages="False" SimulateType="True" Text=""><ui:TypeInto.Target><ui:Target ClippingRegion="{x:Null}" Element="{x:Null}" Selector="" TimeoutMS="{x:Null}" WaitForReady="INTERACTIVE" /></ui:TypeInto.Target></ui:TypeInto>',
  },
  {
    id: 'gettext',
    name: 'Get Text',
    group: 'UI Automation',
    hint: 'Read an element’s text into a variable',
    xaml: '<ui:GetValue ContinueOnError="{x:Null}" DisplayName="Get Text"><ui:GetValue.Target><ui:Target ClippingRegion="{x:Null}" Element="{x:Null}" Selector="" TimeoutMS="{x:Null}" WaitForReady="INTERACTIVE" /></ui:GetValue.Target><ui:GetValue.Value><OutArgument x:TypeArguments="x:String" /></ui:GetValue.Value></ui:GetValue>',
  },
  {
    id: 'openbrowser',
    name: 'Open Browser',
    group: 'UI Automation',
    hint: 'Open a page and work in it',
    xaml: `<ui:OpenBrowser UiBrowser="{x:Null}" BrowserType="Chrome" DisplayName="Open Browser" Url=""><ui:OpenBrowser.Body><ActivityAction x:TypeArguments="x:Object"><ActivityAction.Argument><DelegateInArgument x:TypeArguments="x:Object" Name="ContextTarget" /></ActivityAction.Argument>${seq('Do')}</ActivityAction></ui:OpenBrowser.Body></ui:OpenBrowser>`,
  },
  { id: 'readcsv', name: 'Read CSV', group: 'Data & files', hint: 'Read a .csv file into a DataTable', xaml: '<ui:ReadCsvFile Encoding="{x:Null}" DataTable="{x:Null}" Delimitator="Comma" DisplayName="Read CSV" FilePath="" />' },
  { id: 'writecsv', name: 'Write CSV', group: 'Data & files', hint: 'Write a DataTable to a .csv file', xaml: '<ui:WriteCsvFile Encoding="{x:Null}" DataTable="{x:Null}" Delimitator="Comma" DisplayName="Write CSV" FilePath="" />' },
  {
    id: 'excelscope',
    name: 'Excel Application Scope',
    group: 'Data & files',
    hint: 'Open a workbook and work in it',
    xaml: `<ui:ExcelApplicationScope Password="{x:Null}" DisplayName="Excel Application Scope" WorkbookPath=""><ui:ExcelApplicationScope.Body><ActivityAction x:TypeArguments="ui:WorkbookApplication"><ActivityAction.Argument><DelegateInArgument x:TypeArguments="ui:WorkbookApplication" Name="ExcelWorkbookScope" /></ActivityAction.Argument>${seq('Do')}</ActivityAction></ui:ExcelApplicationScope.Body></ui:ExcelApplicationScope>`,
  },
  { id: 'readrange', name: 'Read Range', group: 'Data & files', hint: 'Read a sheet range into a DataTable', xaml: '<ui:ExcelReadRange DataTable="{x:Null}" AddHeaders="True" DisplayName="Read Range" Range="" SheetName="Sheet1" />' },
  { id: 'writerange', name: 'Write Range', group: 'Data & files', hint: 'Write a DataTable to a sheet', xaml: '<ui:ExcelWriteRange AddHeaders="True" DataTable="{x:Null}" DisplayName="Write Range" SheetName="Sheet1" StartingCell="A1" />' },
  { id: 'log', name: 'Log Message', group: 'System', hint: 'Write to the robot’s log', xaml: '<ui:LogMessage DisplayName="Log Message" Level="Info" Message="[&quot;&quot;]" />' },
  { id: 'messagebox', name: 'Message Box', group: 'System', hint: 'Show a message', xaml: '<ui:MessageBox Caption="{x:Null}" ChosenButton="{x:Null}" DisplayName="Message Box" Text="[&quot;&quot;]" />' },
  { id: 'writeline', name: 'Write Line', group: 'System', hint: 'Write a line to the output', xaml: '<WriteLine DisplayName="Write Line" Text="" />' },
];

export const TEMPLATE_GROUPS: ActivityTemplate['group'][] = ['Workflow', 'Control', 'Error handling', 'UI Automation', 'Data & files', 'System'];

/** Common variable / argument types, as written in XAML (prefix:Type). */
export const COMMON_TYPES: { type: string; label: string }[] = [
  { type: 'x:String', label: 'String' },
  { type: 'x:Int32', label: 'Int32' },
  { type: 'x:Boolean', label: 'Boolean' },
  { type: 'x:Double', label: 'Double' },
  { type: 'x:Object', label: 'Object' },
  { type: 's:DateTime', label: 'DateTime' },
  { type: 's:TimeSpan', label: 'TimeSpan' },
  { type: 'sd:DataTable', label: 'DataTable' },
  { type: 'sd:DataRow', label: 'DataRow' },
  { type: 's:String[]', label: 'String[]' },
  { type: 'scg:List(x:String)', label: 'List<String>' },
  { type: 'scg:Dictionary(x:String, x:Object)', label: 'Dictionary<String, Object>' },
];

/** A blank workflow, for New file ▸ Workflow. */
export const BLANK_WORKFLOW = `<Activity mc:Ignorable="sap sap2010" x:Class="Main" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation" xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main Sequence" />
</Activity>
`;
