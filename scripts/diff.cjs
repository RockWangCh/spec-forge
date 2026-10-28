/**
 * spec-forge — File change detection (git / snapshot diff)
 * Detects changed files via `git status` when in a repo, else via FNV-1a
 * snapshot comparison.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logger } = require('./logger.cjs');

const IGNORE_DIRS = [
  /[\\/]node_modules[\\/]/,
  /[\\/]\.git[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]build[\\/]/,
  /[\\/]\.next[\\/]/,
  /[\\/]__pycache__[\\/]/,
  /[\\/]\.venv[\\/]/,
  /[\\/]vendor[\\/]/,
  /[\\/]coverage[\\/]/,
  /[\\/]\.cache[\\/]/
];

const IGNORE_EXTENSIONS = [
  '.lock', '.log', '.map', '.min.js', '.min.css',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx'
];

function resolveProjectRoot(projectRoot) {
  return projectRoot || process.env.PROJECT_DIR || process.cwd();
}

function shouldIgnore(relativePath) {
  if (!relativePath) return false;
  const norm = String(relativePath).replace(/\\/g, '/');
  if (IGNORE_DIRS.some(function (p) { return p.test('/' + norm + '/'); })) return true;
  const ext = path.extname(norm).toLowerCase();
  if (IGNORE_EXTENSIONS.indexOf(ext) !== -1) return true;
  return false;
}

function findTrackableFiles(rootDir) {
  const files = [];
  function walk(currentDir) {
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      if (IGNORE_DIRS.some(function (p) { return p.test('/' + relativePath + '/'); })) continue;
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IGNORE_EXTENSIONS.indexOf(ext) !== -1) continue;
        files.push(relativePath);
      }
    }
  }
  walk(rootDir);
  return files.sort();
}

function fnv1aBuffer(buf) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function hashFile(filePath) {
  try { return fnv1aBuffer(fs.readFileSync(filePath)); }
  catch (_) { return null; }
}

function isGitRepo(projectRoot) {
  const cwd = resolveProjectRoot(projectRoot);
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe', cwd: cwd });
    return true;
  } catch (_) { return false; }
}

function changedFilesGit(projectRoot) {
  const cwd = resolveProjectRoot(projectRoot);
  try {
    // Do NOT trim() the whole output — porcelain v1 lines start with the
    // index-status column, which is a space for "not staged" entries (e.g.
    // " M src/lib.ts"). Trimming the leading space shifts substring(3) by one
    // and mangles the path ("src/lib.ts" → "rc/lib.ts"). Only strip trailing
    // whitespace/CR (Windows CRLF).
    const output = execSync('git status --porcelain', {
      stdio: 'pipe', encoding: 'utf8', cwd: cwd
    }).replace(/\s+$/, '');
    if (!output) return [];
    const files = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const clean = line.replace(/\r$/, '');
      if (!clean) continue;
      const rest = clean.substring(3).trim();
      const arrowIdx = rest.indexOf(' -> ');
      let p = arrowIdx > -1 ? rest.substring(arrowIdx + 4) : rest;
      if (p.charAt(0) === '"' && p.charAt(p.length - 1) === '"') {
        p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      if (shouldIgnore(p)) continue;
      files.push(p);
    }
    return files;
  } catch (e) {
    logger.error('git status failed', { error: e.message });
    return [];
  }
}

function compareSnapshot(previous, projectRoot) {
  if (!previous || !previous.files) return { changed: [], added: [], removed: [] };
  const root = resolveProjectRoot(projectRoot);
  const trackableFiles = findTrackableFiles(root);
  const currentMap = {};
  for (const file of trackableFiles) {
    const hash = hashFile(path.join(root, file));
    if (hash !== null) currentMap[file] = hash;
  }
  const changed = [], added = [], removed = [];
  for (const file of Object.keys(currentMap)) {
    if (!(file in previous.files)) added.push(file);
    else if (previous.files[file] !== currentMap[file]) changed.push(file);
  }
  for (const file of Object.keys(previous.files)) {
    if (!(file in currentMap)) removed.push(file);
  }
  return { changed: changed, added: added, removed: removed };
}

function findMostRecentSnapshot(projectRoot) {
  const root = resolveProjectRoot(projectRoot);
  const specsDir = path.join(root,  'specs');
  if (!fs.existsSync(specsDir)) return null;
  let bestSnapshot = null, bestTime = 0;
  try {
    const entries = fs.readdirSync(specsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (!/^\d{8}-\d{6}(?:-[a-z0-9]{4})?$/.test(entry.name)) continue;
      const snapDir = path.join(specsDir, entry.name, 'snapshots');
      if (!fs.existsSync(snapDir)) continue;
      let snapshots;
      try {
        snapshots = fs.readdirSync(snapDir)
          .filter(function (f) { return f.startsWith('snapshot-') && f.endsWith('.json'); })
          .sort().reverse();
      } catch (_) { continue; }
      if (snapshots.length > 0) {
        const newestFile = path.join(snapDir, snapshots[0]);
        const stat = fs.statSync(newestFile);
        if (stat.mtimeMs > bestTime) { bestTime = stat.mtimeMs; bestSnapshot = newestFile; }
      }
    }
  } catch (e) { logger.error('Failed to scan for snapshots', { error: e.message }); }
  if (bestSnapshot) {
    try { return JSON.parse(fs.readFileSync(bestSnapshot, 'utf8')); }
    catch (e) { logger.error('Failed to parse snapshot', { error: e.message }); }
  }
  return null;
}

function changedFiles(projectRoot) {
  const root = resolveProjectRoot(projectRoot);
  if (isGitRepo(root)) return changedFilesGit(root);
  const prevSnapshot = findMostRecentSnapshot(root);
  if (prevSnapshot) {
    const result = compareSnapshot(prevSnapshot, root);
    return result.changed.concat(result.added, result.removed);
  }
  return [];
}

module.exports = {
  changedFiles,
  isGitRepo
};
