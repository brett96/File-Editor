/**
 * The user guide's text. Each section is one page; `group` builds the table of contents.
 * Keep names of buttons and menus exactly as they appear in the app (see the `Ui` tag).
 */
import type { ReactNode } from 'react';
import { Defs, DiamondLegend, Go, K, Keys, Note, Shortcuts, SignalFlow, Steps, StudioMap, Tip, Ui, Warn } from './bits';

export interface GuideSection {
  id: string;
  group: string;
  title: string;
  /** only in the desktop app */
  desktop?: boolean;
  /** extra words people may search for */
  keywords?: string;
  body: ReactNode;
}

export const SECTIONS: GuideSection[] = [
  // ───────────────────────────── Getting started ─────────────────────────────
  {
    id: 'welcome',
    group: 'Getting started',
    title: 'Welcome',
    keywords: 'overview introduction privacy web desktop',
    body: (
      <>
        <p>
          File Editor opens, edits, converts and password-protects documents, PDFs, spreadsheets, photos, video and audio. Everything happens on
          your own device: files are never uploaded, and the app works offline.
        </p>
        <Defs
          rows={[
            [<>Documents</>, <>Word (.docx, .doc), OpenDocument, Rich Text, Markdown, HTML, CSS, JavaScript and plain text. See <Go to="documents">Documents</Go>.</>],
            [<>PDF</>, <>Edit existing text, add text, images, links, shapes and signatures; insert, reorder, rotate and delete pages. See <Go to="pdf">PDF editing</Go>.</>],
            [<>Spreadsheets</>, <>Excel (.xlsx), CSV and TSV with 400+ formula functions. See <Go to="spreadsheets">Spreadsheets</Go>.</>],
            [<>Databases</>, <>SQLite and LiteDB (.sqlite, .db, …): browse tables, edit rows and run SQL. See <Go to="databases">Databases</Go>.</>],
            [<>Photos</>, <>Quick edits for any photo; a layered Photoshop-style editor in the desktop app. See <Go to="photo-quick">Photos</Go> and <Go to="photo-pro">Pro Photo</Go>.</>],
            [<>Video &amp; audio</>, <>Quick trims and conversions; a multi-track editor with a mixing console (Studio) in the desktop app. See <Go to="video-quick">Video &amp; audio</Go> and <Go to="studio">Studio</Go>.</>],
          ]}
        />
        <h3>Web version and desktop app</h3>
        <p>
          The web version and the desktop app (Windows and macOS) share the same editors. The desktop app adds two professional workspaces,{' '}
          <Go to="photo-pro">Pro Photo</Go> and <Go to="studio">Studio</Go>, plus opening files from Explorer/Finder, a native menu and automatic
          updates. On the web home screen, <Ui>Download for Windows</Ui> / <Ui>Download for Mac</Ui> fetches the latest production installer (and asks
          which architecture when more than one is available). Licenses are sold at{' '}
          <a href="https://license.bretttomita.com" target="_blank" rel="noopener noreferrer">license.bretttomita.com</a>. Sections that only apply to
          the desktop app are marked <span className="hg-badge">Desktop app</span>.
        </p>
        <Tip>
          Press <Keys k="F1" /> at any time to open this guide, or use <Ui>Help ▸ User Guide</Ui>. Use the search box at the top left to find a topic.
        </Tip>
      </>
    ),
  },
  {
    id: 'files',
    group: 'Getting started',
    title: 'Opening files, tabs and recent files',
    keywords: 'open new blank tab tabs close home recent drag drop format switch convert',
    body: (
      <>
        <h3>Start something new</h3>
        <p>
          <Ui>New</Ui> (or the <Ui>+</Ui> at the end of the tab bar) starts a blank Word document. To make a different kind of file, click the
          format name at the bottom-left of the window (for example <Ui>Word document</Ui>) and pick another: a spreadsheet (Excel, CSV, TSV),
          plain text, HTML, CSS, JavaScript, Markdown, PDF or a blank picture canvas. The content is converted for you; tables become sheets
          and a sheet becomes a table.
        </p>
        <h3>Open a file</h3>
        <ul>
          <li><Ui>Open</Ui> (<Keys k="Ctrl+O" />) and choose a file.</li>
          <li>Drag a file from your desktop or folder onto the window.</li>
          <li>Desktop app: double-click a file in Explorer/Finder, or use <Ui>Open with ▸ File Editor</Ui>.</li>
          <li>
            <Ui>Recent</Ui> lists the files you used last; click one to reopen it, or the <Ui>×</Ui> beside it to remove it from the list. The desktop
            app also has <Ui>File ▸ Open Recent</Ui>, and the home screen shows them too.
          </li>
        </ul>
        <h3>Tabs</h3>
        <p>
          Every file opens in its own tab, so you can work on several at once. A dot on a tab means it has unsaved changes. Click{' '}
          <Ui>File Editor</Ui> at the top left to go back to the home screen; your files stay open.
        </p>
        <Shortcuts
          rows={[
            ['Ctrl+Tab / Ctrl+PageDown', 'Next tab (desktop app)'],
            ['Ctrl+Shift+Tab / Ctrl+PageUp', 'Previous tab (desktop app)'],
            ['Ctrl+W', 'Close the tab (desktop app; in a browser Ctrl+W closes the browser tab)'],
          ]}
        />
        <p>You can also close a tab with its <Ui>×</Ui> or a middle-click.</p>
        <Note>On a Mac, use <K>⌘ Cmd</K> wherever this guide says <K>Ctrl</K>.</Note>
      </>
    ),
  },
  {
    id: 'saving',
    group: 'Getting started',
    title: 'Saving, auto-save and converting',
    keywords: 'save in place save as convert download auto-save autosave format export',
    body: (
      <>
        <h3>Save</h3>
        <p>
          <Ui>Save</Ui> (<Keys k="Ctrl+S" />) writes your changes back into the file you opened, in the same format. Nothing asks where to
          save, just like in Word or Photoshop. A new file asks for a name and folder the first time.
        </p>
        <h3>Save as / Convert</h3>
        <p>
          <Ui>Save as / Convert</Ui> (<Keys k="Ctrl+Shift+S" />) saves a copy under a new name, or in another format: a Word file as PDF, a
          photo as WebP or PDF, a video as MP4 or MP3, a spreadsheet as CSV, and so on. The dialog only offers the formats that make sense for
          the file.
        </p>
        <h3>Auto-save</h3>
        <p>
          With <Ui>Auto-save on</Ui> (bottom right), every change is written to the file a moment after you stop typing or editing. The status bar
          then says <Ui>Auto-saved</Ui> and the time. Click the switch to turn it off, or use <Ui>File ▸ Auto Save</Ui> in the desktop app. If a file
          can't be auto-saved, the switch turns dashed and the status bar says why. The usual reasons:
        </p>
        <ul>
          <li><b>It has never been saved.</b> Save it once, and auto-save takes over from then on.</li>
          <li>
            <b>It's a video or audio file in Quick edit.</b> Saving re-encodes the whole file, which takes a while, so these files are saved only
            when you press <Ui>Save</Ui>.
          </li>
          <li><b>Its format can't be written</b> (for example HEIC photos). Use Save as to pick another format.</li>
          <li>
            <b>A layered Pro Photo picture that isn't a .psd.</b> Saving it as JPEG/PNG would flatten the layers, so save it as Photoshop (.psd) first.
          </li>
          <li><b>In a browser</b>, the browser may ask for permission to edit the file. Press <Ui>Save</Ui> once to allow it.</li>
        </ul>
        <h3>In a web browser</h3>
        <p>
          Chrome and Edge can save straight back into your files, auto-save and remember recent files. Firefox and Safari can't write to files a
          page opened, so there <Ui>Save</Ui> becomes <Ui>Download</Ui> and saves a copy to your Downloads folder. The desktop app always saves
          in place.
        </p>
      </>
    ),
  },
  {
    id: 'protect',
    group: 'Getting started',
    title: 'Passwords and protection',
    keywords: 'password encrypt protect lock unlock pdf permissions restrict docx xlsx',
    body: (
      <>
        <p>
          Password-protected Word, Excel and PDF files open normally: the app asks for the password. When you save, the password is kept unless you
          change it.
        </p>
        <Steps>
          <li>Click <Ui>Protect</Ui> in the top bar (it shows a shield when the file is protected).</li>
          <li>Tick <Ui>Protect with a password</Ui> and type the password twice.</li>
          <li>
            For a PDF, choose <Ui>Require password to open</Ui>, or <Ui>Restrict editing only</Ui> so anyone can open it but only you can lift the
            restrictions. Then untick what others may not do: printing, copying, editing or commenting.
          </li>
          <li>Save. Word and Excel files use Office's own AES-256 encryption, so Office asks for the same password.</li>
        </Steps>
        <Warn>There is no way to recover a forgotten password, and there is no password-removal tool for files you don't have the password for.</Warn>
      </>
    ),
  },

  // ───────────────────────────── Documents ─────────────────────────────
  {
    id: 'documents',
    group: 'Documents',
    title: 'Word-style documents',
    keywords: 'docx word text formatting styles heading font table image link page break margins header footer find replace draw format painter',
    body: (
      <>
        <p>
          Documents look and work like a word processor: the page is shown at its real size under a ribbon with five tabs, <Ui>Home</Ui>,{' '}
          <Ui>Insert</Ui>, <Ui>Draw</Ui>, <Ui>Design</Ui> and <Ui>Layout</Ui>.
        </p>
        <Defs
          rows={[
            [<>Home</>, <>Clipboard, fonts, text and paragraph formatting, lists, alignment, spacing, shading, borders and find &amp; replace.</>],
            [<>Insert</>, <><Ui>Table</Ui> (drag over the grid to pick its size), <Ui>Picture</Ui>, <Ui>Link</Ui>, <Ui>Page break</Ui>, <Ui>Horizontal line</Ui>, <Ui>Header &amp; footer</Ui>, <Ui>Date &amp; time</Ui>, <Ui>Symbol</Ui>, <Ui>Quote</Ui> and <Ui>Code block</Ui>.</>],
            [<>Design</>, <><Ui>Themes</Ui> set the fonts and heading colour of the whole document in one click; <Ui>Fonts</Ui>, <Ui>Heading font</Ui>, <Ui>Colours</Ui> and <Ui>Paragraph spacing</Ui> change one of those at a time. They format the text that is in the document, so every file format keeps them.</>],
            [<>Layout</>, <><Ui>Margins</Ui> (Normal, Narrow, Moderate, Wide or custom), <Ui>Orientation</Ui>, <Ui>Size</Ui>, indents, and space before / after the paragraph in points.</>],
            [<>Text formatting</>, <>Paragraph style (headings), font, size, <Ui>Grow/Shrink font</Ui>, bold, italic, underline, strikethrough, sub/superscript, text colour, highlight, <Ui>Change case</Ui>, <Ui>Clear formatting</Ui>.</>],
            [<>Format painter</>, <>Click inside formatted text, click the brush, then select other text to give it the same look.</>],
            [<>Paragraphs</>, <>Alignment, bulleted and numbered lists, indents, <Ui>Line and paragraph spacing</Ui>, <Ui>Sort</Ui> (A → Z or Z → A, for selected paragraphs or list items).</>],
            [<>Tables</>, <><Ui>Table</Ui> inserts one; with the cursor in a table, the same menu (or right-click) inserts or deletes rows and columns, merges or splits cells, toggles a header row and deletes the table. Click inside a cell to edit its text.</>],
            [<>Pictures</>, <><Ui>Insert image</Ui>, or drop an image onto the text. Select a picture to resize it by its corners or to <Ui>Edit image</Ui> (crop, rotate, adjust).</>],
            [<>Links</>, <><Ui>Link</Ui> (<Keys k="Ctrl+K" />): web address, e-mail or phone number.</>],
            [<>Page layout</>, <><Ui>Page setup</Ui>: paper size, orientation and margins. <Ui>Page break</Ui> (<Keys k="Ctrl+Enter" />) starts a new page.</>],
            [<>Header &amp; footer</>, <>Double-click the top or bottom margin, or use the <Ui>Header &amp; footer</Ui> button. They print on every page.</>],
            [<>Find &amp; replace</>, <><Keys k="Ctrl+F" />, with match case and whole-word options.</>],
            [<>Formatting marks</>, <><Keys k="Ctrl+Shift+8" /> shows paragraph marks and spaces.</>],
            [<>Draw</>, <>A pen, highlighter and eraser for drawing or signing over the page. Each group of strokes becomes a picture that moves with its paragraph.</>],
          ]}
        />
        <Tip>Plain text, Markdown, HTML, CSS and JavaScript open in a code editor with colouring. Switch the format at the bottom left to turn a text file into a formatted document, or the other way round.</Tip>
        <Note>Word files keep the most formatting. Footnotes, comments and tracked changes are not imported yet.</Note>
      </>
    ),
  },
  {
    id: 'pdf',
    group: 'Documents',
    title: 'PDF editing',
    keywords: 'pdf edit text add text sign signature white-out highlight link pages insert merge reorder rotate delete convert',
    body: (
      <>
        <p>Pick a tool in the toolbar, then click or drag on the page.</p>
        <Defs
          rows={[
            [<>Select / move</>, <>Select anything you added to move, resize or delete it (<K>Del</K>).</>],
            [<>Edit existing text</>, <>Click any line of the PDF and retype it. The app covers the old words and writes yours in a matching standard font, keeping bold and italic when it can detect them.</>],
            [<>Add text</>, <>Click where the text should go and type; set the font, size and colour in the toolbar.</>],
            [<>Insert image</>, <>Place a picture, logo or scanned signature.</>],
            [<>Draw / sign</>, <>Draw freehand; use it to sign.</>],
            [<>Highlight area · White-out</>, <>Drag a box to highlight, or to cover content in a solid colour.</>],
            [<>Add link area</>, <>Drag a box and enter a web address, e-mail or phone number.</>],
            [<>Rectangle · Ellipse · Line</>, <>Shapes with fill and line colours and line width.</>],
          ]}
        />
        <h3>Pages</h3>
        <p>
          The page list on the left shows every page; drag thumbnails to reorder them, or use <Ui>Move up</Ui>, <Ui>Move down</Ui>,{' '}
          <Ui>Duplicate</Ui>, <Ui>Rotate</Ui> and <Ui>Delete page</Ui>. The <Ui>Pages</Ui> menu inserts blank pages, or pages from another PDF,
          Word file or picture, which is how you merge files.
        </p>
        <h3>Turning a PDF into a Word document</h3>
        <p>
          Use the magic-wand button in the top bar (<Ui>Convert PDF to editable document</Ui>), or Save as ▸ Word. Paragraphs are rebuilt from the
          text; complex layouts and pictures are not carried over.
        </p>
        <Warn title="White-out is not redaction.">
          Covered or retyped text is still inside the PDF underneath. To remove sensitive text for real, convert the page to a picture and redact it
          in the photo editor.
        </Warn>
      </>
    ),
  },
  {
    id: 'spreadsheets',
    group: 'Documents',
    title: 'Spreadsheets',
    keywords: 'excel xlsx csv tsv formula function sheet cell format freeze sort filter',
    body: (
      <>
        <p>
          Spreadsheets work like Excel or Google Sheets: a formula bar, sheet tabs along the bottom, a formatting toolbar and right-click menus on
          cells, rows and columns.
        </p>
        <Defs
          rows={[
            [<>Home</>, <>Fonts, colours, borders, alignment, wrapping, merging and number formats.</>],
            [<>Insert</>, <>Rows and columns around the selection, a new sheet, today's date and the current time.</>],
            [<>Formulas</>, <><Ui>AutoSum</Ui> totals the selected numbers in the row below them (<Ui>Average</Ui>, <Ui>Count</Ui>, <Ui>Max</Ui> and <Ui>Min</Ui> work the same way), followed by the function library by category.</>],
            [<>Data</>, <><Ui>Sort A→Z</Ui> / <Ui>Sort Z→A</Ui> by the active cell's column (a heading row and total rows stay put), filter, <Ui>Remove duplicates</Ui>, <Ui>Text to columns</Ui> and <Ui>Trim spaces</Ui>.</>],
            [<>View</>, <><Ui>Freeze panes</Ui> keeps the rows above and columns left of the selected cell in view; <Ui>Freeze top row</Ui>, <Ui>Freeze first column</Ui> and <Ui>Unfreeze panes</Ui> do what they say. Zoom and gridlines are here too.</>],
          ]}
        />
        <ul>
          <li>Type <K>=</K> to start a formula, for example <code>=SUM(B2:B20)</code>. More than 400 functions are available.</li>
          <li>Drag the small square at the corner of a selection (the fill handle) to continue a series or copy a formula.</li>
          <li>Use the toolbar for fonts, colours, borders, alignment, wrapping, merging and number formats (currency, percent, dates).</li>
          <li>Freeze panes, sort, filter, hide rows and columns, and find &amp; replace work as in Excel.</li>
          <li>Add, rename, colour and reorder sheets with the tabs at the bottom.</li>
        </ul>
        <h3>What is saved</h3>
        <p>
          .xlsx keeps all sheets, values, formulas, formatting, merged cells, column widths, frozen panes and hidden rows and columns. Charts,
          pictures, comments, conditional formatting and macros are not kept; the app tells you when a file you open uses them. CSV and TSV save
          only the values of the current sheet.
        </p>
        <h3>Save as a database</h3>
        <p>
          <Ui>Save as / Convert</Ui> → <Ui>SQLite database</Ui> turns the workbook into a database with one table per sheet. The row of column
          headings becomes the column names. Where a sheet's heading row is not clear (every column is text, the first row has numbers or gaps, a
          title sits above the headings), you are asked: pick the row that holds the names, choose <Ui>No heading row</Ui>, or type the names
          yourself. Values are saved (formula results rather than formulas), dates as ISO text; the new database then opens for editing.
        </p>
        <h3>Large workbooks</h3>
        <p>
          Big Excel and CSV files (tens of megabytes, hundreds of thousands of rows) are read and written a piece at a time, with a progress bar, so
          the file, its text and its cells are never all in memory at once. A 150 MB workbook with a million rows opens in well under a minute on a
          recent computer. Auto-save is paused for workbooks this size: press <Keys k="Ctrl+S" /> to save.
        </p>
        <p>
          How much the grid can hold depends on the device: about 40 million filled cells on a computer with 8 GB of memory or more, fewer on an
          older laptop or a phone (the limit is worked out from the memory the device reports, so it stops before the page runs out). A file past
          that limit is not refused: File Editor offers to open it as a <strong>database</strong> instead. Each sheet becomes a table, read straight
          from the file a row at a time, which you can page through, edit, search with SQL and save as a SQLite file. Values are kept (formula
          results rather than formulas, dates as ISO text); formatting is not, and the original file is not changed.
        </p>
        <p>
          On a large sheet, anything that has to go through every row (filtering, sorting, replacing, removing duplicates, inserting or deleting
          rows, undo) shows a spinner while it runs, so you can see that the editor is working.
        </p>
        <h3>Column widths</h3>
        <p>
          Drag the line at the right of a column's letter to resize it. Double-click that line (or right-click the letter and choose{' '}
          <Ui>Fit for data</Ui>) to fit the column to its widest value: every row of the column is measured, not just the rows on screen. Select
          several columns first to fit them all.
        </p>
        <Tip>On a phone the sheet opens zoomed to fit. Drag with one finger to scroll, tap to select a cell, and double-tap to edit it.</Tip>
      </>
    ),
  },
  {
    id: 'databases',
    group: 'Documents',
    title: 'Databases (SQLite, LiteDB)',
    keywords: 'sqlite litedb database db table sql query row column edit collection large',
    body: (
      <>
        <p>
          Open a local SQLite file (<code>.sqlite</code>, <code>.sqlite3</code>, <code>.db</code>, <code>.db3</code>) to browse tables and views, edit
          cells, add or delete rows, and run SQL. The database is loaded entirely into memory on this device; nothing is uploaded.
        </p>
        <p>
          To start a database from scratch, choose <Ui>New</Ui> → <Ui>Blank database</Ui> (or, in a blank document, click the format label in the
          status bar and pick <Ui>SQLite database</Ui>). Press <Ui>New table</Ui>, name it and list its columns; the first <Ui>Save</Ui> asks where to
          keep the <code>.sqlite</code> file.
        </p>
        <p>
          <strong>LiteDB</strong> files (the <code>.db</code> files many Windows apps keep their data in) open too: each collection is shown as a
          table with a column per field, and nested values as JSON text you can query with <code>json_extract()</code>. <Ui>Save</Ui> writes your
          changes back to the same file in LiteDB's own format, so the program that owns it keeps working: rows you did not touch are written back
          exactly as they were, edited fields keep their type (dates, Guids, whole numbers), new rows get an <code>_id</code> of the collection's
          kind, and indexes are rebuilt. The first save keeps the original beside it as <code>.bak</code> (a download in the browser). Close the
          other program before saving. <Ui>Save as</Ui> offers a LiteDB copy or a SQLite one. LiteDB 5 files, password-protected files and
          databases with expression indexes open as a copy that saves to SQLite instead.
        </p>
        <Defs
          rows={[
            [<>Tables list</>, <>Pick a table or view on the left. Views are read-only; tables can be edited.</>],
            [<>Edit cells</>, <>Click a cell, change the value, then leave the cell (or press Enter). Empty text becomes NULL when the cell was empty or null.</>],
            [<>Add / delete rows</>, <><Ui>Add row</Ui> inserts a new row. Select rows with the checkboxes and press <Ui>Delete</Ui>.</>],
            [<>New table / Add column</>, <>The <Ui>+</Ui> above the tables list makes a table (name, columns, and an optional numbered <code>id</code> column). <Ui>Add column</Ui> adds a column at the end of the table on screen.</>],
            [<>Resize a column</>, <>Drag the right edge of its heading. Double-click that edge to fit the column to its widest value in the whole table, not just the page on screen.</>],
            [<>Rearrange columns</>, <>Press a heading and drag it left or right; a line shows where it will land. This changes how the table is shown, not how it is stored. SQL results can be resized and rearranged the same way.</>],
            [<>SQL</>, <><Ui>SQL</Ui> opens a console. Run statements with the button or <Keys k="Ctrl+Enter" />. SELECT results appear in the grid; other statements refresh the schema.</>],
            [<>Save</>, <>Save writes the whole database file back (or downloads a copy in the browser). Auto-save works once the file has a place to write.</>],
          ]}
        />
        <Note>Databases up to 2 GB open (rows are shown 200 at a time, so table size doesn't slow the grid); above 48 MB auto-save is paused and you save with <Keys k="Ctrl+S" />. Other apps' private <code>.db</code> formats (Access, Thumbs.db…) are not databases File Editor can read. Binary (BLOB) values are shown but not edited in place. Password-protected or encrypted SQLite files are not supported.</Note>
      </>
    ),
  },

  // ───────────────────────────── Photos ─────────────────────────────
  {
    id: 'photo-quick',
    group: 'Photos',
    title: 'Quick photo editing',
    keywords: 'photo image crop rotate flip resize adjust filter text arrow draw redact blur pixelate face plate',
    body: (
      <>
        <p>Photos open in Quick edit: one picture, with the tools along the top.</p>
        <Defs
          rows={[
            [<>Crop</>, <>Drag the frame's edges or corners, or pick an <Ui>Aspect ratio</Ui> (1:1, 4:5, 16:9, 9:16 story…). Press <K>Enter</K> to apply, <K>Esc</K> to cancel.</>],
            [<>Rotate / Flip</>, <>Turn by 90° or mirror the picture.</>],
            [<>Resize</>, <>Set a new width and height in pixels; untick <Ui>Keep proportions</Ui> to change one without the other.</>],
            [<>Adjust &amp; filters</>, <>One-click looks, plus sliders for exposure, brightness, contrast, highlights, shadows, saturation, warmth, hue and vignette.</>],
            [<>Text · Arrow · Line · Rectangle · Ellipse · Draw</>, <>Add labels and markings. They stay editable until you save: select one to move it, change its colour or delete it.</>],
            [<>Insert image</>, <>Add a logo or sticker on top.</>],
            [<>Redact</>, <>Drag over faces, licence plates or text to <Ui>Pixelate</Ui>, <Ui>Blur</Ui> or cover them with a <Ui>Black box</Ui>.</>],
          ]}
        />
        <Tip>Use Pixelate or Black box for anything private: a light blur can sometimes be reversed, a coarse pixelation can't.</Tip>
        <Note>Saved copies never contain camera details or the GPS location.</Note>
        <p>
          In the desktop app, <Ui>Pro</Ui> in the status bar opens the same picture in <Go to="photo-pro">Pro Photo</Go> for layers, masks and
          retouching.
        </p>
      </>
    ),
  },
  {
    id: 'photo-pro',
    group: 'Pro Photo (layers)',
    title: 'Pro Photo: the workspace',
    desktop: true,
    keywords: 'pro photoshop psd layers workspace',
    body: (
      <>
        <p>
          Pro Photo is a layered editor in the style of Photoshop. Open a photo and click <Ui>Pro</Ui> in the status bar, or open a <code>.psd</code>{' '}
          file directly.
        </p>
        <Defs
          rows={[
            [<>Menu bar</>, <><Ui>Edit</Ui> (undo, cut/copy/paste, fill, Free Transform), <Ui>Image</Ui> (size, canvas, rotate, flip, flatten), <Ui>Layer</Ui>, <Ui>Select</Ui>, <Ui>Filter</Ui>.</>],
            [<>Tools (left)</>, <>Move, selections, brushes, retouching, fills, type, shapes, eyedropper and hand. The bar above the picture shows the current tool's options.</>],
            [<>Layers panel (right)</>, <>The stack of layers: top layers cover lower ones.</>],
            [<>Properties panel (right)</>, <>Settings of the selected layer, such as an adjustment's curve or a text layer's font.</>],
          ]}
        />
        <h3>Saving</h3>
        <p>
          Save as Photoshop (<code>.psd</code>) to keep every layer, mask, blend mode and adjustment layer; Photoshop, GIMP, Affinity and Photopea
          open it. Saving as JPEG or PNG flattens the picture into a single layer, so Save as always suggests .psd for layered work.
        </p>
        <p>
          Switching back to <Ui>Quick edit</Ui> flattens the layers (the app asks first).
        </p>
        <Note>Text, shape and fill layers are stored as pixels in the .psd. Layer styles (shadows, strokes) in files from Photoshop open as pixels.</Note>
      </>
    ),
  },
  {
    id: 'pro-layers',
    group: 'Pro Photo (layers)',
    title: 'Pro Photo: layers, blend modes and masks',
    desktop: true,
    keywords: 'layer blend mode opacity mask hide reveal merge duplicate fill',
    body: (
      <>
        <h3>Layers</h3>
        <ul>
          <li>Add a layer with the Layers panel buttons or the <Ui>Layer</Ui> menu: <Ui>New Layer</Ui>, <Ui>New Fill Layer</Ui> (solid colour or gradient), or an adjustment layer.</li>
          <li><Ui>Layer via Copy</Ui> (<Keys k="Ctrl+J" />) copies the selected area to a new layer; <Ui>Layer via Cut</Ui> (<Keys k="Ctrl+Shift+J" />) moves it.</li>
          <li>The arrow buttons under the Layers panel move the selected layer up or down the stack. The eye hides a layer; the padlock protects it from changes.</li>
          <li>Each layer has an opacity and a <b>blend mode</b>, which sets how it mixes with what's below.</li>
          <li><Ui>Merge Down</Ui> joins a layer with the one under it; <Ui>Flatten Image</Ui> joins them all.</li>
        </ul>
        <Defs
          rows={[
            [<>Multiply</>, <>Darkens: white disappears. Good for shadows and line art.</>],
            [<>Screen</>, <>Lightens: black disappears. Good for light leaks, glows and fire.</>],
            [<>Overlay / Soft light</>, <>Adds contrast; use a grey-based layer to dodge and burn without touching the photo.</>],
            [<>Color / Hue / Saturation / Luminosity</>, <>Take one property from the layer, keep the rest from below; for example, Color tints a black-and-white photo.</>],
          ]}
        />
        <h3>Masks: hide part of a layer without erasing it</h3>
        <Steps>
          <li>Select the layer. Optionally make a selection first.</li>
          <li><Ui>Layer ▸ Reveal All</Ui> adds a white mask that shows everything; <Ui>Reveal Selection</Ui> shows only the selected area.</li>
          <li>Click the mask thumbnail beside the layer so it is outlined; you are now painting on the mask.</li>
          <li>Paint with <b>black to hide</b> and <b>white to show</b>; grey shows partly. A soft brush gives smooth transitions.</li>
          <li>Click the layer thumbnail to go back to painting the picture itself.</li>
        </Steps>
        <Tip>A mask can always be repainted, so nothing is lost. <Ui>Disable Mask</Ui> lets you compare; <Ui>Delete Mask</Ui> removes it.</Tip>
      </>
    ),
  },
  {
    id: 'pro-adjust',
    group: 'Pro Photo (layers)',
    title: 'Pro Photo: adjustment layers',
    desktop: true,
    keywords: 'adjustment curves levels hue saturation color balance black white exposure vibrance photo filter threshold posterize invert non-destructive',
    body: (
      <>
        <p>
          An adjustment layer changes the colours of <b>every layer below it</b> without changing their pixels. You can retune it, hide it or delete
          it at any time.
        </p>
        <Steps>
          <li><Ui>Layer ▸ New Adjustment Layer</Ui> and pick one: Curves, Levels, Hue/Saturation, Color Balance, Black &amp; White, Exposure, Brightness/Contrast, Vibrance, Photo Filter, Invert, Threshold or Posterize.</li>
          <li>Set it in the <Ui>Properties</Ui> panel.</li>
          <li>To affect only part of the picture, select that part first: the adjustment gets a mask (see <Go to="pro-layers">masks</Go>).</li>
        </Steps>
        <h3>Curves</h3>
        <p>
          The graph maps input brightness (left to right: shadows → highlights) to output brightness. Click the line to add a point and drag it:
          up brightens that range, down darkens it. A gentle S-shape (lift the highlights, lower the shadows) adds contrast. Double-click a point to
          remove it.
        </p>
        <h3>Levels</h3>
        <p>
          Move the input black and white sliders inwards, to where the histogram starts and ends, to give a flat photo full contrast;{' '}
          <Ui>Auto</Ui> does it for you. <Ui>Midtones (γ)</Ui> brightens or darkens the mid-tones.
        </p>
      </>
    ),
  },
  {
    id: 'pro-select',
    group: 'Pro Photo (layers)',
    title: 'Pro Photo: selections',
    desktop: true,
    keywords: 'selection marquee lasso magic wand feather inverse deselect add subtract intersect',
    body: (
      <>
        <p>A selection limits painting, filters, fills, copying and new adjustment layers to one area. It shows as moving dashes.</p>
        <Defs
          rows={[
            [<>Rectangular · Elliptical Marquee (<K>M</K>)</>, <>Drag a rectangle or an ellipse.</>],
            [<>Lasso (<K>L</K>)</>, <>Draw around an area freehand.</>],
            [<>Magic Wand (<K>W</K>)</>, <>Click a colour to select similar colours. <Ui>Tolerance</Ui> sets how similar; <Ui>Contiguous</Ui> keeps it to connected pixels.</>],
          ]}
        />
        <h3>Combining selections</h3>
        <p>
          Hold <K>Shift</K> to add to the selection, <K>Alt</K> to subtract from it and <K>Shift</K>+<K>Alt</K> to keep only the overlap. The same
          modes are buttons in the tool bar.
        </p>
        <h3>Select menu</h3>
        <Shortcuts
          rows={[
            ['Ctrl+A', 'Select all'],
            ['Ctrl+D', 'Deselect'],
            ['Ctrl+Shift+I', 'Inverse: swap selected and unselected'],
          ]}
        />
        <p><Ui>Feather…</Ui> softens the edge so edits blend in; <Ui>Load Layer Transparency</Ui> selects everything visible on the layer.</p>
      </>
    ),
  },
  {
    id: 'pro-paint',
    group: 'Pro Photo (layers)',
    title: 'Pro Photo: painting and retouching',
    desktop: true,
    keywords: 'brush eraser clone stamp healing dodge burn bucket gradient type shape eyedropper hand',
    body: (
      <>
        <p>Brush tools share <Ui>Size</Ui>, <Ui>Hardness</Ui> (soft to crisp edge) and <Ui>Opacity</Ui> in the tool bar. Paint goes on the selected layer, inside the selection if there is one.</p>
        <Defs
          rows={[
            [<>Brush (<K>B</K>) · Eraser (<K>E</K>)</>, <>Paint with the foreground colour, or erase to transparency.</>],
            [<>Clone Stamp (<K>S</K>)</>, <><K>Alt</K>-click a clean area to set the source, then paint over a blemish; the source follows your brush.</>],
            [<>Spot Healing (<K>J</K>)</>, <>Click or brush over a spot or dust; it's replaced with texture from around it.</>],
            [<>Dodge · Burn (<K>O</K>)</>, <>Lighten or darken where you paint.</>],
            [<>Paint Bucket · Gradient (<K>G</K>)</>, <>Fill an area of similar colour, or drag to draw a gradient from the foreground to the background colour (tick Radial for a circular one).</>],
            [<>Type (<K>T</K>) · Shape (<K>U</K>)</>, <>Make a text or shape layer; edit it later in Properties.</>],
            [<>Eyedropper (<K>I</K>)</>, <>Pick the foreground colour from the picture; <K>Alt</K>-click picks the background colour.</>],
            [<>Move (<K>V</K>) · Hand (<K>H</K>)</>, <>Move the layer, or scroll around a zoomed picture.</>],
          ]}
        />
        <Tip>Retouch on a duplicate of the photo layer (<Keys k="Ctrl+J" />), so you can compare with the original or lower its opacity.</Tip>
      </>
    ),
  },
  {
    id: 'pro-filters',
    group: 'Pro Photo (layers)',
    title: 'Pro Photo: filters, size and transform',
    desktop: true,
    keywords: 'filter blur gaussian sharpen unsharp mask noise median motion emboss edges image size canvas transform rotate',
    body: (
      <>
        <p>
          <Ui>Filter</Ui>: Gaussian Blur, Unsharp Mask (sharpen), Add Noise, Median (removes speckles), Motion Blur, Emboss and Find Edges. A filter
          applies to the selected layer, inside the selection if there is one.
        </p>
        <p>
          <Ui>Image</Ui>: <Ui>Image Size…</Ui> scales everything; <Ui>Canvas Size…</Ui> adds or trims space around the picture (pick an anchor);
          rotate and flip the whole canvas; <Ui>Flatten Image</Ui>.
        </p>
        <p>
          <Ui>Edit ▸ Free Transform</Ui> (<Keys k="Ctrl+T" />) moves, scales and rotates the selected layer.
        </p>
      </>
    ),
  },

  // ───────────────────────────── Video & audio ─────────────────────────────
  {
    id: 'video-quick',
    group: 'Video & audio',
    title: 'Quick video and audio editing',
    keywords: 'video audio trim cut crop rotate look filter text overlay sound volume mute fade frame gif convert mp4 mp3 extract',
    body: (
      <>
        <p>Video and sound files open in Quick edit: one file, with a player and simple tools. It's the fastest way to trim, fix or convert.</p>
        <h3>Trim the start and end</h3>
        <Steps>
          <li>Play (<K>Space</K> or <K>K</K>) or step frame by frame (<K>←</K> <K>→</K>; with <K>Shift</K>, one second).</li>
          <li>At the first frame you want, press <K>I</K> or <Ui>[ Set start</Ui>. At the last one, press <K>O</K> or <Ui>Set end ]</Ui>.</li>
          <li>You can also type exact times in <Ui>Clip start</Ui> and <Ui>Clip end</Ui>.</li>
        </Steps>
        <Defs
          rows={[
            [<>Crop · Rotate · Flip</>, <>Crop to a region, turn the video or mirror it.</>],
            [<>Look</>, <>Filters and colour sliders (exposure, contrast, saturation, warmth…).</>],
            [<>Text</>, <>Add captions; set each one's position, size, colour and when it appears and disappears.</>],
            [<>Sound</>, <>Volume, mute, and fade in/out.</>],
            [<>Save this frame</>, <>Save the current frame as a picture, or <Ui>Edit frame in the image editor</Ui>.</>],
          ]}
        />
        <h3>Saving and converting</h3>
        <p>
          <Ui>Save</Ui> writes the edited video back into the same file and format (it is re-encoded, which takes a moment).{' '}
          <Ui>Save as / Convert</Ui> lets you choose the format (MP4, WebM, MOV, MKV, animated GIF, AVI…), or just the sound (MP3, M4A, WAV,
          FLAC…), plus codec, quality, a smaller resolution or another frame rate.
        </p>
        <Tip>Trims and format changes without visual edits are copied without re-encoding where possible, so they are fast and lossless.</Tip>
        <Note>Some older formats (AVI, WMV, FLV…) are converted once when opened, which can take a while for long files.</Note>
        <p>
          For several clips, titles, animation or real mixing, switch to <Go to="studio">Studio</Go> with the status bar's <Ui>Studio</Ui> button
          (desktop app).
        </p>
      </>
    ),
  },
  {
    id: 'studio',
    group: 'Studio (video & audio)',
    title: 'Studio: overview',
    desktop: true,
    keywords: 'studio timeline premiere after effects multi-track project fstudio layout',
    body: (
      <>
        <p>
          Studio is a multi-track editor for video and sound, in the spirit of Premiere and After Effects. Combine clips, pictures, titles and music;
          animate them with keyframes; grade colour and remove green screens; and mix the sound with a full mixing console.
        </p>
        <h3>Opening Studio</h3>
        <ul>
          <li>Open a video or audio file and click <Ui>Studio</Ui> in the status bar (next to <Ui>Quick edit</Ui>). The file becomes the first clip.</li>
          <li>Or open a saved Studio project (<code>.fstudio</code>).</li>
        </ul>
        <Note>Changes made in Quick edit are not carried into Studio, and going back to Quick edit discards the Studio timeline (the app asks first). Save the project to keep it.</Note>
        <h3>The window</h3>
        <StudioMap />
        <Defs
          rows={[
            [<>Track</>, <>A row of the timeline. <b>Video tracks</b> (V1, V2…) hold pictures; higher tracks are drawn <b>on top</b> of lower ones. <b>Audio tracks</b> (A1, A2…) hold sound and each has a strip in the Mixer.</>],
            [<>Clip</>, <>One piece of media on a track: a video, a picture, a title, a colour layer or a sound.</>],
            [<>Playhead</>, <>The red line: the moment shown in the preview. Click or drag on the ruler to move it.</>],
            [<>Linked clips</>, <>A video's picture and its sound are added together and move, trim, split and delete together. <Ui>Unlink</Ui> separates them.</>],
            [<>Inspector</>, <>The panel on the right; it shows everything you can set on the selected clip.</>],
          ]}
        />
        <p>
          Next: <Go to="studio-timeline">editing on the timeline</Go> → <Go to="studio-keyframes">animating with keyframes</Go> →{' '}
          <Go to="studio-mixer">mixing the sound</Go> → <Go to="studio-export">saving and exporting</Go>.
        </p>
      </>
    ),
  },
  {
    id: 'studio-timeline',
    group: 'Studio (video & audio)',
    title: 'Studio: editing on the timeline',
    desktop: true,
    keywords: 'add media clip move trim split cut delete unlink snap zoom track mute solo lock hide',
    body: (
      <>
        <h3>Adding things</h3>
        <ul>
          <li><Ui>Add media</Ui>: choose video, audio or picture files. They are placed <b>at the playhead</b>, on the first track with room, and a new track is created if needed.</li>
          <li><Ui>Text</Ui> adds a 5-second title, and <Ui>Colour</Ui> a 5-second colour or gradient layer (see <Go to="studio-titles">titles</Go>).</li>
          <li><Ui>+ Video track</Ui> and <Ui>+ Audio track</Ui> add empty tracks.</li>
        </ul>
        <h3>Arranging clips</h3>
        <Defs
          rows={[
            [<>Select</>, <>Click a clip; it gets a yellow outline and the Inspector shows its settings.</>],
            [<>Move</>, <>Drag the clip sideways to change when it plays, or up and down onto another track of the same kind.</>],
            [<>Trim</>, <>Drag a clip's left or right edge to shorten or lengthen it. A video can't be stretched past the end of its file.</>],
            [<>Split</>, <>Put the playhead where you want to cut and press <K>S</K> (or the scissors). Linked sound is cut too.</>],
            [<>Delete</>, <><K>Delete</K> or the bin removes the selected clip (and its linked sound).</>],
            [<>Unlink</>, <>Separates a video from its sound so you can move or delete one alone.</>],
            [<>Snapping</>, <>The magnet makes clips snap to other clips' edges and to the playhead. Turn it off for free placement.</>],
            [<>Zoom</>, <><Ui>−</Ui> / <Ui>+</Ui> (or <K>-</K> / <K>=</K>) zoom the timeline; <Ui>Fit</Ui> shows everything.</>],
          ]}
        />
        <h3>Track buttons</h3>
        <p>
          At the left of each track: the eye hides a video track, the speaker mutes an audio track, <Ui>S</Ui> (solo) plays only the soloed audio
          tracks, and the padlock locks a track so its clips can't be moved by accident.
        </p>
        <Tip>Undo and redo (<Keys k="Ctrl+Z" /> / <Keys k="Ctrl+Shift+Z" />) cover every Studio change, including mixer moves.</Tip>
      </>
    ),
  },
  {
    id: 'studio-preview',
    group: 'Studio (video & audio)',
    title: 'Studio: preview and playback',
    desktop: true,
    keywords: 'play pause preview frame step position drag layer canvas',
    body: (
      <>
        <Shortcuts
          rows={[
            ['Space', 'Play / pause'],
            ['← / →', 'One frame back / forward'],
            ['Shift+← / Shift+→', 'Ten frames back / forward'],
            ['Home / End', 'Go to the start / end'],
          ]}
        />
        <h3>Placing layers by dragging</h3>
        <p>
          While paused, click a title, picture or video in the preview to select it (a dashed blue box appears) and drag it to move it. It snaps
          to the centre of the frame; hold <K>Shift</K> to move freely. If the clip's position is animated, dragging adds a keyframe at the
          playhead (see <Go to="studio-keyframes">keyframes</Go>).
        </p>
        <p>The preview plays the full mix, effects included, so what you hear is what you'll export, apart from the loudness target, which is applied when exporting.</p>
      </>
    ),
  },
  {
    id: 'studio-titles',
    group: 'Studio (video & audio)',
    title: 'Studio: titles and colour layers',
    desktop: true,
    keywords: 'text title caption lower third font outline background colour solid gradient',
    body: (
      <>
        <Steps>
          <li>Move the playhead to where the title should start and click <Ui>Text</Ui>. A title appears on a video track above your footage.</li>
          <li>In the Inspector, type the words (several lines are fine), and pick the font, size, colour, <Ui>Bold</Ui> and <Ui>Italic</Ui>.</li>
          <li><Ui>Outline</Ui> adds a coloured edge; <Ui>Background box</Ui> puts a box behind the text, which helps on busy footage.</li>
          <li>Drag the title in the preview, or set <Ui>Position X</Ui> and <Ui>Position Y</Ui> exactly.</li>
          <li>Drag the clip's edges on the timeline to set how long it shows. Add <Ui>Fade in</Ui> and <Ui>Fade out</Ui> under Compositing.</li>
        </Steps>
        <p>
          <Ui>Colour</Ui> adds a full-frame colour layer (tick <Ui>Gradient</Ui> for two colours). Use it as a background on the lowest video
          track, or scale it down for a coloured bar behind a lower-third title.
        </p>
      </>
    ),
  },
  {
    id: 'studio-keyframes',
    group: 'Studio (video & audio)',
    title: 'Studio: animating with keyframes',
    desktop: true,
    keywords: 'keyframe animate animation motion diamond easing ease position scale rotation opacity zoom ken burns graph editor curve bezier',
    body: (
      <>
        <p>
          A keyframe stores a value at a moment in time. Studio fills in the frames in between, so with two keyframes a title can glide across the
          screen, fade in, grow or spin. Five properties can be animated: <b>Position X</b>, <b>Position Y</b>, <b>Scale</b>, <b>Rotation</b> and{' '}
          <b>Opacity</b>.
        </p>
        <h3>The diamond buttons</h3>
        <p>Each property in the Inspector's <Ui>Transform</Ui> section has a diamond beside it:</p>
        <DiamondLegend />
        <h3>Example: slide a title in from the left while it fades in</h3>
        <Steps>
          <li>Select the title clip, and move the playhead to the start of the clip. <b>The playhead must be over the clip</b> to add keyframes.</li>
          <li>Set <Ui>Position X</Ui> to a value off the left edge (for example −300) and <Ui>Opacity %</Ui> to 0.</li>
          <li>Click the diamonds of <Ui>Position X</Ui> and <Ui>Opacity %</Ui>. They fill in: two keyframes are set at this moment.</li>
          <li>Move the playhead one second later (click the ruler, or press <K>→</K> a few times with <K>Shift</K>).</li>
          <li>
            Set <Ui>Position X</Ui> to where the title should end up (half the frame width centres it) and <Ui>Opacity %</Ui> to 100. Because these
            properties are already animated, changing them <b>adds keyframes automatically</b> at the playhead.
          </li>
          <li>Press <K>Home</K>, then <K>Space</K>, to watch it.</li>
        </Steps>
        <h3>Working with keyframes</h3>
        <ul>
          <li>The <Ui>‹</Ui> and <Ui>›</Ui> arrows next to “Transform” jump the playhead to the previous or next keyframe of the clip.</li>
          <li>To change a keyframe, jump to it and change the value. To delete it, click its filled diamond.</li>
          <li>The selected clip shows small gold diamonds on the timeline where its keyframes are.</li>
          <li>Keyframe times are measured from the start of the clip, so they move with the clip when you drag it.</li>
          <li>Splitting a clip divides its animation between the two halves.</li>
          <li>Dragging a layer in the preview counts as changing Position X and Y.</li>
        </ul>
        <h3>Easing</h3>
        <p>The menu next to the arrows sets how new keyframes move into the next one:</p>
        <Defs
          rows={[
            [<>Ease in-out</>, <>Starts slowly, speeds up, slows down at the end. Natural for most motion (the default).</>],
            [<>Linear</>, <>Constant speed; mechanical, but right for scrolling credits.</>],
            [<>Ease in</>, <>Starts slowly and accelerates; for things leaving the screen.</>],
            [<>Ease out</>, <>Arrives fast and settles gently; for things entering.</>],
            [<>Hold</>, <>No movement: the value jumps at the next keyframe. Good for blinking or step-by-step reveals.</>],
            [<>Custom curve</>, <>A curve you shape yourself in the graph editor, including overshoot and bounce-back.</>],
          ]}
        />
        <h3>Masks and motion tracking</h3>
        <p>
          <Ui>Mask</Ui> → <Ui>Show only part of this layer</Ui> keeps an ellipse or rectangle of the layer and hides the rest (a yellow outline
          shows it in the preview). <Ui>Feather</Ui> softens the edge; <Ui>Invert</Ui> cuts a hole instead. The mask's position and size can be
          keyframed like any other property.
        </p>
        <p>
          On a video clip, <Ui>Track motion</Ui> makes the mask follow whatever is under it: place the mask over a face, a car or a logo, put
          the playhead where tracking should start, and press the button. Studio steps through the clip, matching the picture frame to frame,
          and writes the mask's position as keyframes. Press the button again to stop early; if the subject is lost (it leaves the frame or
          is covered), move the mask back onto it and track again from there.
        </p>
        <Tip title="Blur a moving face or number plate.">
          Put the same video on two tracks, one above the other. On the upper copy set <Ui>Blur</Ui> to about 20, add a mask over the face
          and track it. Only the masked, blurred patch of the upper copy covers the sharp video below.
        </Tip>
        <h3>3D layers</h3>
        <p>
          The <Ui>3D</Ui> section of the inspector turns any layer (video, picture, title or colour) into a flat card in space, drawn in
          perspective. <Ui>Tilt X</Ui> tips the top away from you, <Ui>Swivel Y</Ui> swings the right edge away, and <Ui>Depth Z</Ui> pushes the
          layer back (or pulls it forward with a negative value). All three can be keyframed, so a title can swing in like a door or a photo
          can fall back into the distance. <Ui>Camera lens</Ui> applies to the whole project: a short lens (24 mm) exaggerates the perspective,
          a long one (135 mm) flattens it. Layers still stack in track order; they do not pass through each other.
        </p>
        <h3>The graph editor</h3>
        <p>
          <Ui>Graph</Ui> (next to <Ui>Timeline</Ui> and <Ui>Mixer</Ui>) shows the selected clip's animation as curves: time runs left to right, the
          value runs bottom to top, and each property has its own colour. Each curve is scaled to its own range, so position and opacity can be
          compared side by side.
        </p>
        <ul>
          <li>Drag a diamond to move a keyframe in time and value. Hold <K>Shift</K> to change only the value, <K>Alt</K> to change only the time.</li>
          <li>Double-click the graph to add a keyframe to the highlighted property (click a property in the list to highlight it).</li>
          <li>Click a diamond to type its exact time and value, choose the easing of the segment that follows it, or delete it.</li>
          <li>Choose <Ui>Custom curve</Ui> and two white handles appear on the segment: drag them to shape the speed. Pull a handle above the end value for an overshoot.</li>
          <li>Untick a property to hide its curve. Click an empty part of the graph to move the playhead there.</li>
        </ul>
        <Tip title="Ken Burns zoom on a photo.">
          Put a picture on the timeline. At its first frame, keyframe <Ui>Scale %</Ui> at 100; at its last frame set it to 120 and nudge Position X
          a little. The slow push-in makes a still photo feel alive.
        </Tip>
        <Warn title="Nothing seems to change?">
          If a property has keyframes, a new value only applies at the playhead, and the other keyframes still control the rest of the clip. Jump
          between keyframes with the arrows to see them all.
        </Warn>
      </>
    ),
  },
  {
    id: 'studio-effects',
    group: 'Studio (video & audio)',
    title: 'Studio: compositing, colour and green screen',
    desktop: true,
    keywords: 'blend mode fade blur shadow colour grade look saturation chroma key green screen tolerance softness spill',
    body: (
      <>
        <h3>Compositing</h3>
        <Defs
          rows={[
            [<>Blend</>, <>How the clip mixes with the tracks below: <Ui>Screen</Ui> for light leaks and flares (black disappears), <Ui>Multiply</Ui> for shadows and textures (white disappears), <Ui>Overlay</Ui> for contrast.</>],
            [<>Fade in / out</>, <>Fades the clip's opacity at its start and end, in seconds. Two clips on different tracks that overlap, with the top one fading out, make a cross-dissolve.</>],
            [<>Blur</>, <>Softens the whole clip; useful for a blurred background copy behind portrait footage.</>],
            [<>Drop shadow</>, <>A soft shadow under the layer, which makes titles and keyed subjects stand out.</>],
          ]}
        />
        <h3>Colour grade (videos and pictures)</h3>
        <p>
          <Ui>Look</Ui> applies a ready-made style. Below it, Exposure, Contrast, Highlights, Shadows, Saturation, Temperature, Hue, Brightness and
          Vignette fine-tune the clip. To match two shots, grade the second until skin tones and whites look like the first.
        </p>
        <h3>Green screen (chroma key)</h3>
        <Steps>
          <li>Put your background (a video, picture or colour layer) on a lower video track, and the green-screen clip on the track <b>above</b> it.</li>
          <li>Select the green-screen clip and tick <Ui>Remove a background colour</Ui> under <Ui>Chroma key</Ui>.</li>
          <li>Set <Ui>Key colour</Ui> to the screen's colour: click the swatch and pick it, ideally with the colour picker's eyedropper.</li>
          <li>Raise <Ui>Tolerance</Ui> until the whole screen disappears, but stop before the subject starts to vanish.</li>
          <li>Raise <Ui>Softness</Ui> for smoother edges, such as hair.</li>
          <li><Ui>Spill</Ui> removes the green tint the screen casts on the subject's edges.</li>
        </Steps>
        <Tip>Even, wrinkle-free lighting on the screen makes a much cleaner key than any setting can.</Tip>
        <h3>Stylize effects</h3>
        <p>
          <Ui>Effects</Ui> → <Ui>Add an effect…</Ui> stacks pixel effects on any layer, applied top to bottom after the colour grade and green
          screen. Untick an effect to compare, or press <Ui>×</Ui> to remove it.
        </p>
        <Defs
          rows={[
            [<>Curl noise</>, <>Swirls the picture along a flowing noise field that drifts as the clip plays: heat haze, water, dream sequences. <Ui>Strength</Ui> is how far pixels move, <Ui>Swirl size</Ui> how large the eddies are.</>],
            [<>Contour</>, <>Traces edges as white lines on black. Raise <Ui>Keep picture</Ui> to draw dark outlines over the original instead.</>],
            [<>Glow</>, <>Bright areas bloom into their surroundings.</>],
            [<>Pixelate</>, <>Mosaic blocks. With a tracked mask on a copy of the clip, it hides a face or a number plate.</>],
            [<>Posterize, Sharpen, RGB split</>, <>Flat poster tones; crisper edges; red and blue pulled apart for a glitch look.</>],
            [<>Luma key</>, <>Makes dark areas transparent, for fire, smoke, sparks and light leaks that were shot on black.</>],
          ]}
        />
      </>
    ),
  },
  {
    id: 'studio-audio-clips',
    group: 'Studio (video & audio)',
    title: 'Studio: clip volume, fades and automation',
    desktop: true,
    keywords: 'audio clip gain fade envelope automation volume ducking music voice',
    body: (
      <>
        <p>Select a sound clip on an audio track to see its settings in the Inspector.</p>
        <Defs
          rows={[
            [<>Gain dB</>, <>Makes this clip louder or quieter before it reaches the track's mixer strip (+6 dB is about twice as loud to the ear).</>],
            [<>Fade in / Fade out</>, <>Smooth start and end, in seconds. Use a short fade (0.05 s) on every cut to avoid clicks.</>],
            [<>Volume envelope</>, <>Volume changes over time, drawn as a yellow line on the clip.</>],
          ]}
        />
        <h3>Example: lower the music while someone speaks (ducking)</h3>
        <Steps>
          <li>Select the music clip. Move the playhead to just before the voice starts and click <Ui>Add point</Ui> (0 dB).</li>
          <li>Move half a second later and click <Ui>Add point</Ui> again, then set that point to −15 dB.</li>
          <li>Add a −15 dB point where the voice ends, and a 0 dB point half a second after it.</li>
          <li>Play it. The music dips under the voice and comes back up. Click a point's time to jump to it, or <Ui>×</Ui> to remove it.</li>
        </Steps>
      </>
    ),
  },
  {
    id: 'studio-waveform',
    group: 'Studio (video & audio)',
    title: 'Studio: the waveform editor',
    desktop: true,
    keywords: 'waveform edit cut copy paste silence normalize reverse noise gate noise reduction hiss hum clean',
    body: (
      <>
        <p>
          For detailed sound repair, select a sound clip and click <Ui>Edit waveform…</Ui> in the Inspector. The editor shows the clip's waveform;
          drag across it to select a range (or <Ui>Select all</Ui>), and play it with <Ui>Play selection</Ui>.
        </p>
        <Defs
          rows={[
            [<>Cut · Copy · Paste · Delete</>, <>As in a text editor. Paste goes in at the yellow cursor, or replaces the selection.</>],
            [<>Silence · Insert silence</>, <>Mute the selection (keeping its length), or insert a gap of the given length at the cursor.</>],
            [<>Gain · Normalize (−1 dB)</>, <>Raise or lower the level by a number of dB, or make the loudest peak −1 dB. These work on the selection, or on the whole clip when nothing is selected.</>],
            [<>Fade in · Fade out · Reverse</>, <>Shape or reverse the selection.</>],
            [<>Noise gate</>, <>Silences everything quieter than the threshold (for example −45 dB), which removes background hiss and room sound <i>between</i> words. Set it below the quietest speech.</>],
            [<>Learn noise profile · Reduce noise</>, <>Removes steady noise such as hiss, hum or fans, even <i>under</i> the speech. See below.</>],
          ]}
        />
        <h3>Removing background noise</h3>
        <Steps>
          <li>Find a moment with <b>only</b> the noise (a pause before someone speaks) and select at least half a second of it.</li>
          <li>Click <Ui>Learn noise profile</Ui>.</li>
          <li>Click on the waveform to clear the selection (to clean the whole clip), set the strength (50–70% is a good start) and click <Ui>Reduce noise</Ui>.</li>
          <li>Listen. If voices sound watery or robotic, undo and try a lower strength.</li>
        </Steps>
        <p>
          The editor has its own undo and redo. <Ui>Apply to clip</Ui> saves the result as a new sound for the clip. <b>Your original file is never
          changed</b>, and the Studio undo can go back too.
        </p>
        <Note>If an edit changes the clip's length (cut, delete, insert silence), the sound is unlinked from its video, because they no longer line up.</Note>
      </>
    ),
  },
  {
    id: 'studio-mixer',
    group: 'Studio (video & audio)',
    title: 'Studio: the mixing console',
    desktop: true,
    keywords: 'mixer console fader meter pan mute solo master channel strip level db',
    body: (
      <>
        <p>
          Click <Ui>Mixer</Ui> (top right of the Studio toolbar) to swap the timeline for the mixing console. Each audio track has a channel strip,
          and the <b>Master</b> strip on the right controls the final mix. Changes are heard immediately while the project plays.
        </p>
        <SignalFlow />
        <h3>Using the controls</h3>
        <ul>
          <li>Drag a slider, or click its number and type a value, then press <K>Enter</K>. <K>↑</K> / <K>↓</K> nudge it (<K>Shift</K> for 10 steps), and <K>Esc</K> cancels.</li>
          <li><b>Double-click</b> a slider to reset it (faders reset to 0 dB).</li>
          <li>Tick an effect's name (EQ, Compressor, Delay, Reverb) to switch it on and show its settings.</li>
          <li><Ui>Pan</Ui> places the sound left or right; type <code>L30</code>, <code>R20</code> or <code>C</code>.</li>
          <li><Ui>M</Ui> mutes the track and <Ui>S</Ui> solos it, which is handy for listening to one voice on its own.</li>
        </ul>
        <h3>Reading the meters</h3>
        <p>
          The bar beside each fader shows the level while playing: <b>green</b> is fine, <b>yellow</b> (above −9 dB) is loud, and <b>red</b> (above
          −1 dB) is close to distorting. Aim for speech peaking around −12 to −6 dB on its track, then use the master limiter and loudness target
          for the final level (see <Go to="studio-loudness">loudness</Go>).
        </p>
        <p>Next: <Go to="studio-audio-fx">what each effect does, with starting settings</Go>.</p>
      </>
    ),
  },
  {
    id: 'studio-audio-fx',
    group: 'Studio (video & audio)',
    title: 'Studio: EQ, compressor, delay and reverb',
    desktop: true,
    keywords: 'eq equalizer low cut high cut shelf mid frequency q compressor threshold ratio attack release makeup delay echo feedback reverb decay voice podcast',
    body: (
      <>
        <h3>EQ (tone)</h3>
        <Defs
          rows={[
            [<>Low cut</>, <>Removes rumble below this frequency (traffic, handling noise, air-con). 80–100 Hz for voices; 0 is off.</>],
            [<>Low</>, <>Boosts or cuts the bass (a shelf around 120 Hz). Cut a little if a voice sounds boomy.</>],
            [<>Mid · Mid freq · Mid Q</>, <>Boosts or cuts a band around <Ui>Mid freq</Ui>; <Ui>Mid Q</Ui> sets its width (higher is narrower). Cutting 2–3 dB around 300–500 Hz clears muddiness; a small boost around 3 kHz makes speech clearer.</>],
            [<>High</>, <>Brightness (a shelf around 8 kHz). Add 2–3 dB of “air” to dull recordings.</>],
            [<>High cut</>, <>Removes everything above this frequency, for example hiss; 0 is off.</>],
          ]}
        />
        <h3>Compressor (evens out the volume)</h3>
        <p>The compressor turns down the loud parts, so quiet and loud passages end up closer together; then <Ui>Makeup</Ui> raises everything back up.</p>
        <Defs
          rows={[
            [<>Threshold</>, <>Level above which it starts working. Lower means it works on more of the sound.</>],
            [<>Ratio</>, <>How strongly: 3:1 means 3 dB over the threshold becomes 1 dB. 2–4:1 is natural; 10:1 and up is very heavy.</>],
            [<>Attack · Release</>, <>How fast it reacts (ms) and lets go. A slow attack keeps the punch of drums; a fast one catches peaks.</>],
            [<>Makeup</>, <>Gain added afterwards to restore the level.</>],
          ]}
        />
        <Tip title="Voice starting point:">
          Low cut 90 Hz · Compressor threshold −20 dB, ratio 3:1, attack 10 ms, release 150 ms, makeup +4 dB.
        </Tip>
        <h3>Delay and reverb (space)</h3>
        <Defs
          rows={[
            [<>Delay</>, <><Ui>Time</Ui> between echoes, <Ui>Feedback</Ui> (how many repeats) and <Ui>Mix</Ui> (how loud the echoes are). 300–400 ms with low feedback is a classic slap.</>],
            [<>Reverb</>, <>The sound of a room: <Ui>Decay</Ui> is its size (1 s for a small room, 3 s and up for a hall) and <Ui>Mix</Ui> its amount. Keep voices dry, or below 0.15 mix.</>],
          ]}
        />
      </>
    ),
  },
  {
    id: 'studio-loudness',
    group: 'Studio (video & audio)',
    title: 'Studio: master, limiter and loudness',
    desktop: true,
    keywords: 'master limiter ceiling loudness lufs normalize youtube spotify podcast broadcast measure',
    body: (
      <>
        <Defs
          rows={[
            [<>Master fader</>, <>The overall volume of the mix.</>],
            [<>Limiter · Ceiling</>, <>A safety net that stops peaks from going above the ceiling, so the export never distorts. −1 dB is the usual setting.</>],
            [<>Loudness (export)</>, <>Makes the exported file exactly as loud as the platform expects, measured in LUFS (perceived loudness).</>],
          ]}
        />
        <h3>Choosing a loudness target</h3>
        <Defs
          rows={[
            [<>−14 LUFS</>, <>YouTube, Spotify, TikTok, Instagram and most streaming.</>],
            [<>−16 LUFS</>, <>Podcasts and Apple platforms.</>],
            [<>−23 LUFS · −24 LKFS</>, <>TV and broadcast (Europe EBU R128 · US ATSC A/85).</>],
            [<>Off</>, <>Export the mix as it is.</>],
          ]}
        />
        <p>
          <Ui>Measure loudness</Ui> renders the whole mix and shows its loudness now and after the target and limiter, before you export. The target
          is applied <b>only when exporting</b>; the preview plays the mix as it is.
        </p>
        <Tip>Platforms turn louder uploads down anyway, so matching their target keeps your dynamics instead of having them squashed.</Tip>
      </>
    ),
  },
  {
    id: 'studio-export',
    group: 'Studio (video & audio)',
    title: 'Studio: saving projects and exporting',
    desktop: true,
    keywords: 'save project fstudio export render mp4 webm mov audio mixdown quality resolution frame rate',
    body: (
      <>
        <h3>Save the project (keep editing later)</h3>
        <p>
          <Ui>Save</Ui> (<Keys k="Ctrl+S" />) saves a Studio project, a <code>.fstudio</code> file. The first time, choose where. It holds the
          timeline, effects, keyframes and mix <b>and a copy of every media file you used</b>, so it can be moved to another computer and reopened
          intact. After the first save, auto-save keeps it up to date.
        </p>
        <Note>Because the media is inside, a project is about as large as its media files.</Note>
        <h3>Export the finished video or sound</h3>
        <Steps>
          <li>Click <Ui>Save as / Convert</Ui>.</li>
          <li>Pick a <b>Format</b>: MP4 (plays everywhere), WebM, MOV, MKV or TS for video, or a sound format (MP3, M4A, WAV, FLAC, Ogg, Opus) for an audio-only mixdown. <Ui>Studio project</Ui> saves the project under a new name instead.</li>
          <li>Choose the <Ui>Quality</Ui>, and optionally a smaller <Ui>Resolution</Ui> or another <Ui>Frame rate</Ui>.</li>
          <li>Click <Ui>Export</Ui>. Every frame is rendered with all its effects; you can cancel at any time.</li>
        </Steps>
        <Tip>The export uses the project's loudness target. Check it in Mixer ▸ Master before a final export.</Tip>
      </>
    ),
  },
  {
    id: 'studio-recipes',
    group: 'Studio (video & audio)',
    title: 'Studio: recipes',
    desktop: true,
    keywords: 'recipe how to picture in picture crossfade replace audio music podcast lower third',
    body: (
      <>
        <h3>Picture-in-picture</h3>
        <p>Put the small video on a track above the main one. Set <Ui>Scale %</Ui> to 30, drag it into a corner, and tick <Ui>Drop shadow</Ui>.</p>
        <h3>Cross-dissolve between two shots</h3>
        <p>Put the second shot on the track above the first so they overlap by one second, then give the top clip a <Ui>Fade in</Ui> of 1 s.</p>
        <h3>Replace a video's sound with music</h3>
        <p>Select the video, click <Ui>Unlink</Ui>, select its sound clip and press <K>Delete</K>. Then <Ui>Add media</Ui> with the playhead at the start, choose the music, and trim its end to the video's end.</p>
        <h3>Clean podcast voice</h3>
        <p>
          On each voice: waveform editor ▸ noise reduction (see <Go to="studio-waveform">waveform editor</Go>), then in the Mixer: EQ low cut 90 Hz
          and compressor 3:1 (see <Go to="studio-audio-fx">effects</Go>). Master: limiter on, loudness −16 LUFS. Export as MP3 or M4A.
        </p>
        <h3>Lower-third name title</h3>
        <p>
          Add a <Ui>Colour</Ui> layer, scale it to about 40% and drag it to the lower left. Add a <Ui>Text</Ui> clip on the track above it with the
          name. Give both a 0.3 s fade in and out, and keyframe Position X on both to slide in.
        </p>
      </>
    ),
  },

  // ───────────────────────────── Reference ─────────────────────────────
  {
    id: 'shortcuts',
    group: 'Reference',
    title: 'Keyboard shortcuts',
    keywords: 'keyboard shortcuts keys hotkeys',
    body: (
      <>
        <h3>Everywhere</h3>
        <Shortcuts
          rows={[
            ['F1', 'Open this guide'],
            ['Ctrl+O', 'Open a file'],
            ['Ctrl+N', 'New document (desktop app)'],
            ['Ctrl+S', 'Save'],
            ['Ctrl+Shift+S', 'Save as / Convert'],
            ['Ctrl+P', 'Print'],
            ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
            ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab (desktop app)'],
            ['Ctrl+W', 'Close tab (desktop app)'],
            ['Ctrl+= / Ctrl+-', 'Zoom documents and PDFs in / out (Ctrl+0: 100%)'],
          ]}
        />
        <h3>Documents</h3>
        <Shortcuts
          rows={[
            ['Ctrl+B / Ctrl+I / Ctrl+U', 'Bold / italic / underline'],
            ['Ctrl+K', 'Link'],
            ['Ctrl+Enter', 'Page break'],
            ['Ctrl+F', 'Find & replace'],
            ['Ctrl+] / Ctrl+[', 'Grow / shrink font'],
            ['Ctrl+Shift+8', 'Show formatting marks'],
          ]}
        />
        <h3>Video &amp; audio (Quick edit)</h3>
        <Shortcuts
          rows={[
            ['Space / K', 'Play / pause'],
            ['← / →', 'Previous / next frame (Shift: one second)'],
            ['I / O', 'Set the clip start / end'],
          ]}
        />
        <h3>Studio</h3>
        <Shortcuts
          rows={[
            ['Space', 'Play / pause'],
            ['← / →', 'Previous / next frame (Shift: ten frames)'],
            ['Home / End', 'Start / end'],
            ['S', 'Split at the playhead'],
            ['Delete', 'Delete the selected clip'],
            ['= / -', 'Zoom the timeline in / out'],
            ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
          ]}
        />
        <h3>Pro Photo</h3>
        <Shortcuts
          rows={[
            ['V M L W', 'Move · Marquee · Lasso · Magic Wand'],
            ['B E S J', 'Brush · Eraser · Clone Stamp · Spot Healing'],
            ['O G T U I H', 'Dodge/Burn · Bucket/Gradient · Type · Shape · Eyedropper · Hand'],
            ['Ctrl+J / Ctrl+Shift+J', 'Layer via copy / cut'],
            ['Ctrl+T', 'Free transform'],
            ['Ctrl+A / Ctrl+D / Ctrl+Shift+I', 'Select all / deselect / inverse'],
          ]}
        />
        <h3>Photos (Quick edit)</h3>
        <Shortcuts
          rows={[
            ['Enter / Esc', 'Apply / cancel a crop'],
            ['Delete', 'Delete the selected text, shape or drawing'],
            ['Arrow keys', 'Nudge the selected item'],
          ]}
        />
      </>
    ),
  },
  {
    id: 'desktop-app',
    group: 'Reference',
    title: 'Desktop app: license and updates',
    desktop: true,
    keywords: 'license key activate purchase update version restart log',
    body: (
      <>
        <h3>License</h3>
        <p>
          <Ui>Help ▸ Enter License Key…</Ui> activates a license you bought. Paste the key from the e-mail and click Activate; it shows{' '}
          <Ui>View License Info…</Ui> afterwards. A license is for one computer. All features work without one. The app re-checks an activated
          license whenever it checks for updates, so a refund or revoke is applied on that same schedule (window title, Help menu, and a notice).
        </p>
        <h3>Updates</h3>
        <p>
          The app checks for new versions in the background and downloads them for you. When one is ready, a banner offers <Ui>Restart now</Ui>,
          or it installs the next time you close the app. <Ui>Help ▸ Check for Updates…</Ui> checks immediately; <Ui>Show Update Log</Ui> helps if
          something goes wrong.
        </p>
      </>
    ),
  },
  {
    id: 'troubleshooting',
    group: 'Reference',
    title: 'Troubleshooting',
    keywords: 'problem error help faq cannot open save download slow encoder permission',
    body: (
      <>
        <Defs
          rows={[
            [<>Save downloads a copy instead of saving</>, <>Your browser can't write to files (Firefox, Safari, phones). Use Chrome or Edge, or the desktop app, to save in place.</>],
            [<>“Press Save once to let the browser save this file automatically”</>, <>The browser needs your permission to change the file. Press <Ui>Save</Ui> and allow it; auto-save then works.</>],
            [<>A video or sound file won't open, or takes long</>, <>Formats the built-in decoders can't read are converted once on opening. Very large files in such formats are best converted to MP4 first, especially on phones.</>],
            [<>Studio can't add a file</>, <>Open the file on its own first (it is converted), save it as MP4 or WAV, then add that.</>],
            [<>“No encoder for … is available”</>, <>That codec isn't available on this computer. Pick MP4 (H.264) or WebM in Save as.</>],
            [<>The text I covered in a PDF can still be copied</>, <>White-out hides text but doesn't remove it. See <Go to="pdf">PDF editing</Go>.</>],
            [<>I forgot a file's password</>, <>It can't be recovered; encryption has no back door.</>],
          ]}
        />
        <p>Your files never leave your device, so there is nothing to reset online. Reopening the file from Recent is always safe.</p>
      </>
    ),
  },
];
