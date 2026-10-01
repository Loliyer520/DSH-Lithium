// Shared alias store: persistence, scope merging, parameter expansion.
// Used by the aliases, repeat-detector, and slash-command modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ALIAS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PARAM_RE = /<([A-Za-z_][A-Za-z0-9_]*)(?:=([^>]*))?>/g;
const ASSIGNMENT_RE = /([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|[^\s]+)/g;

export function defaultStoragePath() {
  const profileDir = process.env.DSH_PROFILE_DIR;
  const base = profileDir && profileDir.trim().length > 0
    ? profileDir
    : path.join(os.homedir(), '.dsh');
  return path.join(base, 'command-aliases.json');
}

export function workspaceStoragePath(cwd) {
  return path.join(cwd, '.dsh', 'command-aliases.json');
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEntry(value) {
  if (!value || typeof value.expansion !== 'string' || value.expansion.trim().length === 0) return undefined;
  return {
    expansion: value.expansion,
    ...(typeof value.description === 'string' && value.description.length > 0
      ? { description: value.description }
      : {}),
    ...(value.kind === 'text' ? { kind: 'text' } : {}),
    ...(value.confirm === true ? { confirm: true } : {}),
  };
}

/** Read one alias store file. Corrupt or missing files yield an empty map. */
export function loadAliases(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const source = raw && typeof raw === 'object' && raw.aliases && typeof raw.aliases === 'object'
      ? raw.aliases
      : {};
    const clean = {};
    for (const [key, value] of Object.entries(source)) {
      if (!ALIAS_NAME_RE.test(key)) continue;
      const entry = normalizeEntry(value);
      if (entry) clean[key] = entry;
    }
    return clean;
  } catch {
    return {};
  }
}

export function saveAliases(file, aliases) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ aliases }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** Workspace entries shadow global entries with the same name. */
export function loadMergedAliases(globalFile, cwd) {
  const global = loadAliases(globalFile);
  if (typeof cwd !== 'string' || cwd.length === 0) return { merged: global, global, workspace: {} };
  const workspace = loadAliases(workspaceStoragePath(cwd));
  return { merged: { ...global, ...workspace }, global, workspace };
}

/** Extract declared `<name>` / `<name=default>` placeholders from an expansion. */
export function parseParams(expansion) {
  const params = [];
  const seen = new Set();
  for (const match of expansion.matchAll(PARAM_RE)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    params.push({ name: match[1], default: match[2] });
  }
  return params;
}

/** Parse `key=value` / `key="quoted value"` pairs following an alias token. */
export function parseAssignments(text) {
  const values = {};
  for (const match of text.matchAll(ASSIGNMENT_RE)) {
    values[match[1]] = match[3] ?? match[4] ?? match[2];
  }
  return values;
}

function substituteParams(aliasName, expansion, params, values) {
  for (const key of Object.keys(values)) {
    if (!params.some((p) => p.name === key)) {
      throw new Error(
        `alias "${aliasName}" has no parameter <${key}>. Declared parameters: ${
          params.map((p) => (p.default !== undefined ? `<${p.name}=${p.default}>` : `<${p.name}>`)).join(', ') || '(none)'}`,
      );
    }
  }
  const missing = params.filter((p) => values[p.name] === undefined && p.default === undefined);
  if (missing.length > 0) {
    throw new Error(
      `alias "${aliasName}" requires parameter(s) ${missing.map((p) => `<${p.name}>`).join(', ')}; ` +
      `pass them right after the alias token, e.g. "${aliasName} ${missing[0].name}=value"`,
    );
  }
  return expansion.replace(PARAM_RE, (whole, paramName, defaultValue) => {
    const value = values[paramName] ?? defaultValue;
    return value === undefined ? whole : value;
  });
}

/**
 * Replace standalone alias tokens in `command` with their expansions.
 * A token counts as standalone when it is not glued to other word characters
 * (`A-Za-z0-9_-`). Aliases whose expansion declares `<param>` placeholders also
 * consume the `key=value` assignments that immediately follow the token.
 * Text-kind aliases (prompt presets) never expand. Each alias is replaced in a
 * single pass, so an expansion mentioning its own name is never re-expanded.
 */
export function expandCommand(command, aliases) {
  const names = Object.keys(aliases)
    .filter((n) => aliases[n].kind !== 'text')
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return { command, applied: [] };
  const applied = [];
  let result = command;
  for (const aliasName of names) {
    const entry = aliases[aliasName];
    const params = parseParams(entry.expansion);
    if (params.length === 0) {
      const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(aliasName)}(?![A-Za-z0-9_-])`, 'g');
      result = result.replace(re, () => {
        if (!applied.includes(aliasName)) applied.push(aliasName);
        return entry.expansion;
      });
    } else {
      const re = new RegExp(
        `(?<![A-Za-z0-9_-])${escapeRegExp(aliasName)}` +
        `((?:[ \\t]+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\\s]+))*)`,
        'g',
      );
      result = result.replace(re, (_whole, assigns) => {
        const values = parseAssignments(assigns ?? '');
        if (!applied.includes(aliasName)) applied.push(aliasName);
        return substituteParams(aliasName, entry.expansion, params, values);
      });
    }
  }
  return { command: result, applied };
}

/** Public, secret-free view of one alias entry. */
export function publicView(aliasName, entry, scope) {
  return {
    name: aliasName,
    scope,
    kind: entry.kind ?? 'command',
    description: entry.description ?? null,
    confirm: entry.confirm === true,
    parameters: parseParams(entry.expansion).map((p) =>
      p.default !== undefined ? `<${p.name}=${p.default}>` : `<${p.name}>`),
    expansionLength: entry.expansion.length,
  };
}

/** Render a delegated pwsh/bash result value the same way those tools do. */
export function renderShellValue(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (value.kind === 'background') return `started background job ${value.jobId}`;
  if (value.kind === 'promoted') {
    const out = typeof value.output === 'string' && value.output.length > 0
      ? value.output.endsWith('\n') ? value.output : `${value.output}\n`
      : '';
    return `${out}[still running after ${value.timeoutMs}ms; moved to background job ${value.jobId}]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.`;
  }
  // foreground
  const streamText = (s) => {
    if (!s || typeof s.text !== 'string' || s.text.length === 0) return '';
    let text = s.text;
    if (s.truncated && typeof s.spillPath === 'string') {
      text = `[output truncated to its tail; full output: ${s.spillPath}]\n${text}`;
    }
    return text;
  };
  const out = streamText(value.stdout);
  const err = streamText(value.stderr);
  let body = out;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n';
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = '(no output)';
  const markers = [];
  if (value.sandbox && value.sandbox.denied) {
    markers.push(`[sandbox: file access denied under ${value.sandbox.mode ?? 'sandbox'} mode]`);
  }
  if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`);
  if (value.signal != null) markers.push(`[killed by signal: ${value.signal}]`);
  else if (typeof value.exitCode === 'number' && value.exitCode !== 0) {
    markers.push(`[exit code: ${value.exitCode}]`);
  }
  if (markers.length === 0) return body;
  if (!body.endsWith('\n')) body += '\n';
  return body + markers.join('\n');
}

export const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd;
