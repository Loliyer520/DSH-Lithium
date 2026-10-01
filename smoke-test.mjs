// Smoke test for agent-toolkit: drives apply() with a mock Cordis context and
// exercises every module: aliases, repeat detector, slash command, toggles.
import { apply } from './index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-test-'));
const store = path.join(tmp, 'global', 'aliases.json');
const workspace = path.join(tmp, 'ws');
fs.mkdirSync(workspace, { recursive: true });

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok:', msg); };

function makeCtx() {
  const tools = new Map();
  const listeners = new Map();
  const sections = [];
  const commands = new Map();
  const ctx = {
    effect(fn) { fn(); },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
    tools: {
      register(def) { tools.set(def.name, def); return () => tools.delete(def.name); },
      get(name) {
        if (name === 'pwsh') {
          return {
            async execute(args) {
              return { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, stdout: { text: `RAN: ${args.command}\n`, truncated: false }, stderr: { text: '', truncated: false } };
            },
          };
        }
        return undefined;
      },
    },
    systemPrompt: { section(s) { sections.push(s); return () => {}; } },
    commands: { register(def) { commands.set(def.name, def); return () => commands.delete(def.name); } },
  };
  return { ctx, tools, listeners, sections, commands };
}

const agent = { session: { header: { cwd: workspace } } };
const exec = { agent };
const next = () => Promise.resolve({ kind: 'allow' });

// ---------- full stack ----------
{
  const { ctx, tools, listeners, sections, commands } = makeCtx();
  apply(ctx, { storagePath: store });

  assert(tools.has('command_alias') && tools.has('run_command'), 'alias tools registered');
  assert(listeners.has('tools/pre-execute') && listeners.has('tools/post-execute'), 'guards and detector registered');
  assert(sections.length === 1, 'prompt section registered');
  assert(commands.has('alias'), '/alias command registered');

  const alias = tools.get('command_alias');
  const run = tools.get('run_command');

  // basic alias + expansion
  await alias.execute({ action: 'set', name: 'remote_shell', expansion: "sshpass -p 's3cret' ssh user@192.168.1.10", description: 'prod box' }, exec);
  let r = await run.execute({ command: 'remote_shell "df -h"', description: 'Disk' }, exec);
  assert(r.stdout.text.includes("sshpass -p 's3cret' ssh user@192.168.1.10 \"df -h\""), 'alias expanded');

  // parameterized alias
  await alias.execute({ action: 'set', name: 'deploy', expansion: 'ssh u@h "./deploy.sh <env=prod> <branch>"' }, exec);
  r = await run.execute({ command: 'deploy branch=main', description: 'Deploy' }, exec);
  assert(r.stdout.text.includes('./deploy.sh prod main'), 'params: default + explicit');

  // confirm guard
  await alias.execute({ action: 'set', name: 'nuke', expansion: 'rm -rf /tmp/build --yes --force', confirm: true }, exec);
  const preExecute = listeners.get('tools/pre-execute');
  const d = await preExecute({ name: 'run_command', arguments: { command: 'nuke now', description: 'x' }, agent }, next);
  assert(d.kind === 'ask', 'confirm alias -> ask');

  // text preset not expanded
  await alias.execute({ action: 'set', name: 'checklist', kind: 'text', expansion: 'Check errors and logs.' }, exec);
  r = await run.execute({ command: 'echo checklist', description: 'x' }, exec);
  assert(r.stdout.text.includes('echo checklist'), 'text preset not expanded');

  // prompt section hides secrets, annotates
  const text = sections[0].text();
  assert(text.includes('remote_shell') && !text.includes('s3cret') && text.includes('confirm-guarded'), 'prompt section correct');

  // ----- repeat detector -----
  const postExecute = listeners.get('tools/post-execute');
  const mkResult = () => ({ isError: false, value: {}, content: [{ type: 'text', text: 'output' }] });
  const cmd = 'sshpass -p hunter2 ssh -o StrictHostKeyChecking=no admin@10.0.0.1 "systemctl status nginx"';

  let out = await postExecute({ name: 'pwsh', arguments: { command: cmd, description: 'x' }, agent }, mkResult(), next);
  assert(out.kind === 'allow', 'first occurrence passes untouched');

  out = await postExecute({ name: 'pwsh', arguments: { command: cmd.replace('status', 'restart'), description: 'x' }, agent }, mkResult(), next);
  assert(out.kind === 'accept' && out.content.length === 2 && out.content[1].text.includes('Repetition detected'), 'second occurrence appends hint');
  assert(!out.content[1].text.includes('hunter2'), 'hint fingerprint truncates before the secret tail');

  out = await postExecute({ name: 'pwsh', arguments: { command: cmd, description: 'x' }, agent }, mkResult(), next);
  assert(out.kind === 'allow', 'no repeat nagging after suggestion');

  out = await postExecute({ name: 'pwsh', arguments: { command: 'ls -la', description: 'x' }, agent }, mkResult(), next);
  assert(out.kind === 'allow', 'short command ignored');

  out = await postExecute({ name: 'pwsh', arguments: { command: cmd, description: 'x' }, agent }, { ...mkResult(), isError: true }, next);
  assert(out.kind === 'allow', 'error results ignored');

  out = await postExecute({ name: 'run_command', arguments: { command: 'remote_shell "uptime and more args here"', description: 'x' }, agent }, mkResult(), next);
  assert(out.kind === 'allow', 'run_command with applied alias ignored');

  out = await postExecute({ name: 'read', arguments: { file_path: '/x' }, agent }, mkResult(), next);
  assert(out.kind === 'allow', 'non-shell tools untouched');

  // ----- slash command -----
  const slash = commands.get('alias');
  const inv = (rawInput) => ({ rawInput, agent, signal: undefined });
  r = slash.handler(inv(''));
  assert(r.kind === 'success' && r.text.includes('remote_shell') && !r.text.includes('s3cret'), '/alias lists without secrets');

  r = slash.handler(inv('set --workspace proj_shell ssh proj@10.0.0.5'));
  assert(r.kind === 'success', '/alias set --workspace');
  assert(fs.existsSync(path.join(workspace, '.dsh', 'command-aliases.json')), 'workspace store written by /alias');

  r = await run.execute({ command: 'proj_shell uptime', description: 'x' }, exec);
  assert(r.stdout.text.includes('ssh proj@10.0.0.5 uptime'), 'workspace alias from /alias expands');

  r = slash.handler(inv('set --text review_tones 保持礼貌但直接'));
  assert(r.kind === 'success' && r.text.includes('文本预字符串'), '/alias set --text');

  r = slash.handler(inv('remove --workspace proj_shell'));
  assert(r.kind === 'success', '/alias remove --workspace');

  r = slash.handler(inv('remove nonexistent'));
  assert(r.kind === 'error', '/alias remove missing -> error');

  r = slash.handler(inv('bogus'));
  assert(r.kind === 'error' && r.text.includes('用法'), '/alias unknown action -> usage');
}

// ---------- module toggles ----------
{
  const { ctx, tools, listeners, sections, commands } = makeCtx();
  apply(ctx, { storagePath: store, modules: { repeatDetector: false, slashCommand: false, promptSection: false } });
  assert(tools.has('run_command'), 'aliases still on');
  assert(!listeners.has('tools/post-execute'), 'detector off');
  assert(sections.length === 0, 'prompt section off');
  assert(commands.size === 0, 'slash command off');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll toolkit smoke tests passed.');
