import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPS, GitError, addWorktree, cloneRepo, findRepo, initRepo, runCustom, type OpContext } from '../electron/git-runner';
import {
  cloneFolderName,
  groupChanges,
  isRefName,
  isRemoteUrl,
  isRepoPath,
  parseGithubRemote,
  parseStatus,
  parseUnifiedDiff,
  splitCommandLine,
  type GitStatus,
} from '../src/core/git/parse';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe('git argument checks', () => {
  it('accepts real ref names and refuses options and odd characters', () => {
    for (const ok of ['main', 'feature/login', 'v1.2.3', 'fix-#12', 'release/2024.1']) expect(isRefName(ok)).toBe(true);
    for (const bad of ['-f', '--upload-pack=x', 'a..b', 'a b', 'x.lock', 'a/', '/a', 'a//b', '.hidden', 'a/.b', 'x@{1}', 'a:b', 'a~1', '', '@']) expect(isRefName(bad)).toBe(false);
  });

  it('accepts repository URLs but not options or command transports', () => {
    for (const ok of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@host/x', '/srv/repo', 'C:\\repos\\x', 'file:///tmp/r']) expect(isRemoteUrl(ok)).toBe(true);
    for (const bad of ['--upload-pack=touch x', '-oProxyCommand=x', 'ext::sh -c x', 'fd::3', 'https://a b', '']) expect(isRemoteUrl(bad)).toBe(false);
  });

  it('accepts repository paths only', () => {
    expect(isRepoPath('src/a b.ts')).toBe(true);
    expect(isRepoPath('-rf')).toBe(true); // always passed after "--"
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:/x', 'a\0b']) expect(isRepoPath(bad)).toBe(false);
  });

  it('splits typed commands like a shell would, without one', () => {
    expect(splitCommandLine('git log --oneline -5')).toEqual(['log', '--oneline', '-5']);
    expect(splitCommandLine(`commit -m "fix: it's \\"done\\"" --allow-empty`)).toEqual(['commit', '-m', 'fix: it\'s "done"', '--allow-empty']);
    expect(splitCommandLine("tag -a v1 -m 'a b'")).toEqual(['tag', '-a', 'v1', '-m', 'a b']);
    expect(splitCommandLine('log ""')).toEqual(['log', '']);
    expect(() => splitCommandLine('log "x')).toThrow();
  });

  it('reads GitHub remotes and clone folder names', () => {
    expect(parseGithubRemote('https://github.com/acme/app.git')).toEqual({ owner: 'acme', repo: 'app' });
    expect(parseGithubRemote('git@github.com:acme/app')).toEqual({ owner: 'acme', repo: 'app' });
    expect(parseGithubRemote('https://gitlab.com/acme/app')).toBeNull();
    expect(cloneFolderName('https://github.com/acme/my-app.git')).toBe('my-app');
    expect(cloneFolderName('git@host:x/y.git/')).toBe('y');
  });

  it('parses porcelain v2 status with renames, conflicts and odd names', () => {
    const out = [
      '# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a a file with spaces.ts',
      '2 R. N... 100644 100644 100644 a a R100 new name.ts', 'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c both.ts',
      '? new\nline.txt',
      '',
    ].join('\0');
    const s = parseStatus(out);
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(s.files).toEqual([
      { path: 'file with spaces.ts', index: '.', worktree: 'M' },
      { path: 'new name.ts', origPath: 'old name.ts', index: 'R', worktree: '.' },
      { path: 'both.ts', index: 'U', worktree: 'U', conflict: true },
      { path: 'new\nline.txt', index: '?', worktree: '?', untracked: true },
    ]);
    const g = groupChanges(s.files);
    expect([g.conflicts.length, g.staged.length, g.unstaged.length]).toEqual([1, 1, 2]);
  });

  it('parses unified diffs with line numbers', () => {
    const d = parseUnifiedDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\n');
    expect(d.added).toBe(1);
    expect(d.lines.filter((l) => l.kind !== 'meta').map((l) => `${l.kind}${l.a ?? ''}/${l.b ?? ''}:${l.text}`)).toEqual(['hunk/:@@ -1,3 +1,3 @@', 'same1/1:a', 'del2/:b', 'add/2:B', 'same3/3:c']);
  });
});

describe.skipIf(!hasGit)('git operations (real repositories)', () => {
  let base: string;
  let origin: string;
  let work: string;
  let c: OpContext;
  const env = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test', GIT_CONFIG_NOSYSTEM: '1', HOME: '' };
  const status = async () => (await OPS.status(c, {})) as GitStatus & { groups: ReturnType<typeof groupChanges> };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'fe-git-'));
    env.HOME = base;
    Object.assign(process.env, env);
    origin = join(base, 'origin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', origin]);
    work = join(base, 'work');
    mkdirSync(work);
    await initRepo(work, 'main');
    const repo = (await findRepo(work))!;
    c = { repo, network: {} };
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('finds the repository and its prefix from a subfolder', async () => {
    mkdirSync(join(work, 'src'));
    const r = await findRepo(join(work, 'src'));
    expect(r?.prefix).toBe('src/');
    expect(await findRepo(base)).toBeNull();
  });

  it('stages, unstages, commits and diffs (including before the first commit)', async () => {
    writeFileSync(join(work, 'src', 'a.ts'), 'one\ntwo\n');
    writeFileSync(join(work, '-weird name.txt'), 'x');
    let s = await status();
    expect(s.branch).toBe('main');
    expect(s.groups.unstaged.map((f) => f.path).sort()).toEqual(['-weird name.txt', 'src/a.ts']);
    await OPS.stage(c, { paths: ['src/a.ts', '-weird name.txt'] });
    s = await status();
    expect(s.groups.staged).toHaveLength(2);
    await OPS.unstage(c, { paths: ['-weird name.txt'] });
    s = await status();
    expect(s.groups.staged.map((f) => f.path)).toEqual(['src/a.ts']);
    await expect(OPS.commit(c, { message: '' })).rejects.toThrow(/message/);
    await OPS.commit(c, { message: 'first' });
    writeFileSync(join(work, 'src', 'a.ts'), 'one\nTWO\n');
    const d = (await OPS.diff(c, { path: 'src/a.ts' })) as ReturnType<typeof parseUnifiedDiff>;
    expect([d.added, d.removed]).toEqual([1, 1]);
    const u = (await OPS.diff(c, { path: '-weird name.txt', untracked: true })) as ReturnType<typeof parseUnifiedDiff>;
    expect(u.lines.map((l) => l.text)).toEqual(['x']);
    await OPS.discard(c, { paths: ['src/a.ts'], untracked: ['-weird name.txt'] });
    expect(readFileSync(join(work, 'src', 'a.ts'), 'utf8')).toBe('one\ntwo\n');
    expect((await status()).files).toHaveLength(0);
  });

  it('refuses option-like names', async () => {
    await expect(OPS.createBranch(c, { name: '--force' })).rejects.toBeInstanceOf(GitError);
    await expect(OPS.addRemote(c, { name: 'x', url: '--upload-pack=touch pwned' })).rejects.toThrow(/URL/);
    await expect(OPS.stage(c, { paths: ['../outside'] })).rejects.toBeInstanceOf(GitError);
  });

  it('pushes a new branch with upstream, fetches and pulls', async () => {
    await OPS.addRemote(c, { name: 'origin', url: origin });
    await OPS.push(c, {});
    let s = await status();
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(0);

    // another clone pushes a commit; this one pulls it
    const other = await cloneRepo(base, origin, 'other', {});
    writeFileSync(join(other, 'b.txt'), 'b');
    execFileSync('git', ['add', '.'], { cwd: other });
    execFileSync('git', ['commit', '-m', 'from other'], { cwd: other });
    execFileSync('git', ['push'], { cwd: other });
    await OPS.fetch(c, {});
    s = await status();
    expect(s.behind).toBe(1);
    await OPS.pull(c, {});
    expect((await status()).behind).toBe(0);
    const log = (await OPS.log(c, { limit: 5 })) as { subject: string }[];
    expect(log.map((l) => l.subject)).toEqual(['from other', 'first']);
  });

  it('manages branches, merges and reports a conflicted merge', async () => {
    await OPS.createBranch(c, { name: 'feature/x' });
    writeFileSync(join(work, 'src', 'a.ts'), 'feature\n');
    await OPS.commit(c, { message: 'feature change', all: true });
    await OPS.checkout(c, { branch: 'main' });
    writeFileSync(join(work, 'src', 'a.ts'), 'main\n');
    await OPS.commit(c, { message: 'main change', all: true });
    const branches = (await OPS.branches(c, {})) as { name: string; remote: boolean; current: boolean }[];
    expect(branches.find((b) => b.current)?.name).toBe('main');
    expect(branches.some((b) => b.name === 'origin/main' && b.remote)).toBe(true);
    await expect(OPS.merge(c, { branch: 'feature/x' })).rejects.toBeInstanceOf(GitError);
    let s = await status();
    expect(s.operation).toBe('merge');
    expect(s.groups.conflicts.map((f) => f.path)).toEqual(['src/a.ts']);
    await OPS.operation(c, { action: 'abort' });
    s = await status();
    expect(s.operation).toBeNull();
    await OPS.renameBranch(c, { from: 'feature/x', to: 'feature/y' });
    await OPS.deleteBranch(c, { name: 'feature/y', force: true });
    expect(((await OPS.branches(c, {})) as { name: string }[]).some((b) => b.name.startsWith('feature/'))).toBe(false);
  });

  it('stashes, tags and worktrees', async () => {
    writeFileSync(join(work, 'src', 'a.ts'), 'stashed\n');
    writeFileSync(join(work, 'new.txt'), 'n');
    await OPS.stash(c, { message: 'wip' });
    expect((await status()).files).toHaveLength(0);
    const stashes = (await OPS.stashes(c, {})) as { ref: string; message: string }[];
    expect(stashes[0]).toMatchObject({ ref: 'stash@{0}' });
    expect(stashes[0].message).toContain('wip');
    expect(((await OPS.stashFiles(c, { ref: 'stash@{0}' })) as { path: string }[]).map((f) => f.path).sort()).toEqual(['new.txt', 'src/a.ts']);
    await OPS.stashApply(c, { ref: 'stash@{0}', pop: true });
    expect(readFileSync(join(work, 'src', 'a.ts'), 'utf8')).toBe('stashed\n');
    expect(await OPS.stashes(c, {})).toEqual([]);
    await OPS.discard(c, { all: true });
    expect((await status()).files).toHaveLength(0);

    await OPS.createTag(c, { name: 'v1.0', message: 'Release 1' });
    await OPS.createTag(c, { name: 'light' });
    const tags = (await OPS.tags(c, {})) as { name: string; annotated: boolean }[];
    expect(tags.find((t) => t.name === 'v1.0')?.annotated).toBe(true);
    expect(tags.find((t) => t.name === 'light')?.annotated).toBe(false);
    await OPS.pushTags(c, { remote: 'origin' });
    expect(execFileSync('git', ['tag'], { cwd: origin, encoding: 'utf8' })).toContain('v1.0');
    await OPS.deleteTag(c, { name: 'light' });

    const wt = join(base, 'wt-hotfix');
    await addWorktree(c.repo, wt, { newBranch: 'hotfix' });
    const trees = (await OPS.worktrees(c, {})) as { path: string; branch: string | null }[];
    expect(trees.map((t) => t.branch)).toContain('hotfix');
  });

  it('runs a typed command and reports identity', async () => {
    expect(await runCustom(work, ['log', '--format=%s', '-1'], {})).toBe('main change');
    await OPS.setIdentity(c, { name: 'Local Name', email: 'local@example.test' });
    expect(await OPS.identity(c, {})).toEqual({ name: 'Local Name', email: 'local@example.test' });
  });
});
