/**
 * Source-code and configuration files that open in the code editor as plain UTF-8 text.
 *
 * HTML, CSS and JavaScript have their own formats (they can be previewed and converted); every
 * other language shares the generic `code` format: the file keeps its own extension and is
 * written back exactly as text. Syntax highlighting is chosen from the file name by the editor
 * (`ui/code/CodeEditor`), so this table only decides which editor a file opens in and what
 * the status bar calls it.
 */

/** [display name, extensions…] — the first extension is the usual one. */
const LANGUAGES: [string, ...string[]][] = [
  ['TypeScript', 'ts', 'mts', 'cts'],
  ['TypeScript (TSX)', 'tsx'],
  ['JavaScript (JSX)', 'jsx'],
  ['JavaScript', 'cjs'],
  ['JSON', 'json', 'jsonc', 'json5', 'jsonl', 'map', 'webmanifest', 'geojson', 'ipynb'],
  ['Python', 'py', 'pyw', 'pyi'],
  ['Ruby', 'rb', 'rake', 'gemspec'],
  ['Go', 'go'],
  ['Rust', 'rs'],
  ['Java', 'java'],
  ['Kotlin', 'kt', 'kts'],
  ['C', 'c', 'h'],
  ['C++', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'],
  ['C#', 'cs', 'csx'],
  ['Objective-C', 'm', 'mm'],
  ['PHP', 'php', 'phtml'],
  ['Swift', 'swift'],
  ['SQL', 'sql', 'psql', 'ddl'],
  ['Shell script', 'sh', 'bash', 'zsh', 'fish', 'ksh'],
  ['PowerShell', 'ps1', 'psm1', 'psd1'],
  ['Batch file', 'bat', 'cmd'],
  ['YAML', 'yml', 'yaml'],
  ['TOML', 'toml'],
  ['INI / properties', 'ini', 'cfg', 'conf', 'properties', 'env', 'editorconfig'],
  ['XML', 'xml', 'xsd', 'xsl', 'xslt', 'plist', 'csproj', 'vbproj', 'fsproj', 'props', 'targets', 'resx', 'xaml', 'wsdl', 'rss', 'atom'],
  ['Vue', 'vue'],
  ['Svelte', 'svelte'],
  ['Astro', 'astro'],
  ['Sass', 'scss', 'sass'],
  ['Less', 'less'],
  ['Stylus', 'styl'],
  ['Lua', 'lua'],
  ['Perl', 'pl', 'pm'],
  ['R', 'r', 'rmd'],
  ['Dart', 'dart'],
  ['Scala', 'scala', 'sc', 'sbt'],
  ['Haskell', 'hs', 'lhs'],
  ['Elixir', 'ex', 'exs'],
  ['Erlang', 'erl', 'hrl'],
  ['Clojure', 'clj', 'cljs', 'cljc', 'edn'],
  ['F#', 'fs', 'fsx', 'fsi'],
  ['Visual Basic', 'vb', 'vbs', 'bas'],
  ['Groovy', 'groovy', 'gradle', 'gvy'],
  ['Julia', 'jl'],
  ['Zig', 'zig'],
  ['Nim', 'nim'],
  ['OCaml', 'ml', 'mli'],
  ['Pascal', 'pas', 'pp'],
  ['Fortran', 'f', 'f90', 'f95', 'for'],
  ['Assembly', 'asm', 's'],
  ['CMake', 'cmake'],
  ['Makefile', 'mk', 'mak'],
  ['Dockerfile', 'dockerfile'],
  ['Protocol Buffers', 'proto'],
  ['GraphQL', 'graphql', 'gql'],
  ['Terraform', 'tf', 'tfvars', 'hcl'],
  ['Nix', 'nix'],
  ['Diff', 'diff', 'patch'],
  ['LaTeX', 'tex', 'sty', 'cls', 'bib'],
  ['reStructuredText', 'rst'],
  ['AsciiDoc', 'adoc', 'asciidoc'],
  ['Handlebars', 'hbs', 'handlebars', 'mustache'],
  ['Template', 'ejs', 'njk', 'liquid', 'twig', 'jinja', 'j2', 'erb', 'pug', 'haml'],
  ['WebAssembly text', 'wat', 'wast'],
  ['Solidity', 'sol'],
  ['Lock file', 'lock'],
  ['Git file', 'gitignore', 'gitattributes', 'gitmodules', 'gitkeep'],
  ['Ignore file', 'npmignore', 'dockerignore', 'eslintignore', 'prettierignore'],
  ['Config file', 'npmrc', 'nvmrc', 'babelrc', 'eslintrc', 'prettierrc', 'browserslistrc', 'htaccess'],
];

/** Well-known file names that have no extension of their own. */
const FILE_NAMES: Record<string, string> = {
  dockerfile: 'Dockerfile',
  containerfile: 'Dockerfile',
  makefile: 'Makefile',
  gnumakefile: 'Makefile',
  'cmakelists.txt': 'CMake',
  gemfile: 'Ruby',
  rakefile: 'Ruby',
  podfile: 'Ruby',
  vagrantfile: 'Ruby',
  brewfile: 'Ruby',
  procfile: 'Config file',
  jenkinsfile: 'Groovy',
  justfile: 'Makefile',
  caddyfile: 'Config file',
  codeowners: 'Config file',
  '.env': 'INI / properties',
};

const LABEL_BY_EXT = new Map<string, string>();
for (const [label, ...exts] of LANGUAGES) for (const ext of exts) if (!LABEL_BY_EXT.has(ext)) LABEL_BY_EXT.set(ext, label);

/** Every extension (no dot, lower case) that opens as source code. */
export const CODE_EXTENSIONS: string[] = [...LABEL_BY_EXT.keys()];

const FORMAT_LABELS: Record<string, string> = { html: 'HTML', htm: 'HTML', xhtml: 'HTML', css: 'CSS', js: 'JavaScript', mjs: 'JavaScript' };

function leafName(name: string): string {
  return name.replace(/^.*[\\/]/, '');
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(leafName(name));
  return m ? m[1].toLowerCase() : '';
}

/** `.env.local`, `.env.production`: environment files whose last part is not an extension we know. */
function isEnvFile(leaf: string): boolean {
  return /^\.env(\.[\w-]+)*$/i.test(leaf);
}

/** Whether a file opens in the code editor as generic source (not HTML / CSS / JS, which have their own formats). */
export function isCodeFileName(name: string): boolean {
  const leaf = leafName(name).toLowerCase();
  if (FILE_NAMES[leaf] || isEnvFile(leaf)) return true;
  // "Dockerfile.dev", "Makefile.am"
  if (/^(dockerfile|containerfile|makefile)\.[\w-]+$/.test(leaf)) return true;
  return LABEL_BY_EXT.has(extOf(leaf));
}

/** What to call a source file's language ("TypeScript", "YAML"); "Plain text" when unknown. */
export function languageLabel(name: string): string {
  const leaf = leafName(name).toLowerCase();
  if (FILE_NAMES[leaf]) return FILE_NAMES[leaf];
  if (isEnvFile(leaf)) return 'INI / properties';
  const prefixed = /^(dockerfile|containerfile|makefile)\.[\w-]+$/.exec(leaf);
  if (prefixed) return prefixed[1] === 'makefile' ? 'Makefile' : 'Dockerfile';
  const ext = extOf(leaf);
  return FORMAT_LABELS[ext] ?? LABEL_BY_EXT.get(ext) ?? 'Plain text';
}

/** Languages a browser can't run as written: a page that references one needs a build step first. */
export function needsBuildStep(path: string): boolean {
  return ['ts', 'tsx', 'jsx', 'mts', 'cts', 'vue', 'svelte', 'astro', 'scss', 'sass', 'less', 'styl'].includes(extOf(path));
}
