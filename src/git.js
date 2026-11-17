// 作品文件夹的 git 管理：每个分支是一版稿件。调用系统自带的 git。
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');

const IGNORE = '.DS_Store\n*.tmp\n*.lotus-move\n';

function git(dir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// 没配置 git 身份的机器也要能提交
async function identityArgs(dir) {
  const email = await git(dir, ['config', 'user.email']).catch(() => '');
  return email.trim() ? [] : ['-c', 'user.name=Lotus', '-c', 'user.email=lotus@localhost'];
}

async function isRepo(dir) {
  try {
    await fs.access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(dir) {
  if (await isRepo(dir)) return false;
  await git(dir, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(dir, '.gitignore'), IGNORE, 'utf8');
  return true;
}

async function isDirty(dir) {
  return (await git(dir, ['status', '--porcelain'])).trim().length > 0;
}

// 有改动才提交；返回是否真的提交了
async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  if (!(await isDirty(dir))) return false;
  await git(dir, [...(await identityArgs(dir)), 'commit', '-q', '-m', message]);
  return true;
}

async function hasCommits(dir) {
  return git(dir, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
}

async function status(dir) {
  if (!(await isRepo(dir))) return { repo: false };
  const born = await hasCommits(dir);
  const branch = (await git(dir, ['branch', '--show-current'])).trim();
  const branches = born
    ? (await git(dir, ['branch', '--format=%(refname:short)'])).split('\n').filter(Boolean)
    : [branch];
  const log = born
    ? (await git(dir, ['log', '-n', '15', '--date=format:%m-%d %H:%M', '--format=%h%x09%s%x09%cd'])).split('\n').filter(Boolean).map((line) => {
        const [hash, subject, when] = line.split('\t');
        return { hash, subject, when };
      })
    : [];
  return { repo: true, branch, branches, dirty: await isDirty(dir), log };
}

async function validBranch(dir, name) {
  await git(dir, ['check-ref-format', '--branch', name]).catch(() => {
    throw new Error(`“${name}”不能用作分支名（不能含空格、~ ^ : ? * [ 等字符）`);
  });
}

async function createBranch(dir, name) {
  await validBranch(dir, name);
  await commitAll(dir, '自动保存（新建分支前）');
  await git(dir, ['switch', '-q', '-c', name]);
}

async function switchBranch(dir, name) {
  await commitAll(dir, '自动保存（切换分支前）');
  await git(dir, ['switch', '-q', name]);
}

async function deleteBranch(dir, name) {
  const current = (await git(dir, ['branch', '--show-current'])).trim();
  if (name === current) throw new Error('不能删除当前所在的分支');
  await git(dir, ['branch', '-D', name]);
}

module.exports = { ensureRepo, commitAll, status, createBranch, switchBranch, deleteBranch, hasCommits };
