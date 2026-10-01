// Module: slash-command — a user-facing /alias command so aliases can be
// managed straight from the composer without spending a model turn.
import {
  ALIAS_NAME_RE,
  loadAliases,
  loadMergedAliases,
  parseParams,
  publicView,
  saveAliases,
  workspaceStoragePath,
} from './store.js';

const USAGE = [
  '用法：',
  '  /alias                              列出全部别名（全局 + 当前工作区）',
  '  /alias set <name> <expansion>       设置全局别名',
  '  /alias set --workspace <name> <expansion>   设置当前工作区别名',
  '  /alias set --text <name> <text>     设置文本预字符串（不在 run_command 中展开）',
  '  /alias set --confirm <name> <expansion>     执行前需要用户审批',
  '  /alias remove [--workspace] <name>  删除别名',
  '别名可含 <参数> 或 <参数=默认值> 占位符，例如：',
  '  /alias set deploy sshpass -p x ssh u@h "cd /app && ./deploy.sh <env=prod>"',
].join('\n');

function formatList(storagePath, cwd) {
  const workspaceFile = typeof cwd === 'string' && cwd.length > 0 ? workspaceStoragePath(cwd) : undefined;
  const { global: globalAliases, workspace: workspaceAliases } = loadMergedAliases(storagePath, cwd);
  const rows = [
    ...Object.entries(globalAliases).map(([n, e]) => publicView(n, e, 'global')),
    ...Object.entries(workspaceAliases).map(([n, e]) => publicView(n, e, 'workspace')),
  ];
  if (rows.length === 0) {
    return `还没有定义别名。\n全局存储：${storagePath}\n工作区存储：${workspaceFile ?? '(无)'}\n\n${USAGE}`;
  }
  const lines = [`共 ${rows.length} 个别名（展开串已隐藏）：`];
  for (const row of rows) {
    const bits = [
      `[${row.scope}]`,
      row.kind === 'text' ? 'text' : undefined,
      row.confirm ? '需审批' : undefined,
      row.parameters.length > 0 ? `参数: ${row.parameters.join(' ')}` : undefined,
      row.description ?? undefined,
    ].filter(Boolean);
    lines.push(`- ${row.name} ${bits.join(' · ')}`);
  }
  lines.push('', `全局存储：${storagePath}`, `工作区存储：${workspaceFile ?? '(无)'}`);
  return lines.join('\n');
}

/**
 * @param ctx plugin context
 * @param env shared environment: { storagePath }
 */
export function registerSlashCommand(ctx, env) {
  const { storagePath } = env;

  ctx.effect(() => ctx.commands.register({
    name: 'alias',
    description: '管理命令别名和文本预字符串（list / set / remove）',
    input: { hint: 'list | set [--workspace] [--text] [--confirm] <name> <expansion> | remove [--workspace] <name>' },
    handler(invocation) {
      const cwd = invocation.agent?.session?.header?.cwd;
      const input = invocation.rawInput.trim();

      if (input.length === 0 || input === 'list') {
        return { kind: 'success', text: formatList(storagePath, cwd) };
      }

      const tokens = input.split(/\s+/);
      const action = tokens[0];

      if (action === 'set' || action === 'remove') {
        const flags = new Set();
        let i = 1;
        while (i < tokens.length && tokens[i].startsWith('--')) {
          flags.add(tokens[i]);
          i += 1;
        }
        const unknown = [...flags].filter((f) => !['--workspace', '--text', '--confirm'].includes(f));
        if (unknown.length > 0) return { kind: 'error', text: `未知选项：${unknown.join(' ')}\n\n${USAGE}` };

        const name = tokens[i];
        if (!name || !ALIAS_NAME_RE.test(name)) {
          return { kind: 'error', text: `别名名无效：${name ?? '(缺失)'}（字母/数字/_/-，字母或 _ 开头）\n\n${USAGE}` };
        }

        const toWorkspace = flags.has('--workspace');
        const file = toWorkspace
          ? (cwd ? workspaceStoragePath(cwd) : undefined)
          : storagePath;
        if (file === undefined) return { kind: 'error', text: '当前会话没有工作区，无法使用 --workspace。' };
        const store = loadAliases(file);

        if (action === 'remove') {
          if (flags.has('--text') || flags.has('--confirm')) {
            return { kind: 'error', text: `remove 不接受 --text/--confirm。\n\n${USAGE}` };
          }
          if (!(name in store)) {
            return { kind: 'error', text: `别名 "${name}" 不在${toWorkspace ? '工作区' : '全局'}存储中。` };
          }
          delete store[name];
          saveAliases(file, store);
          return { kind: 'success', text: `已删除${toWorkspace ? '工作区' : '全局'}别名 "${name}"。` };
        }

        // set: expansion 是 name 之后的原始剩余文本（保留空格与引号）
        const nameStart = input.indexOf(name, input.indexOf(action) + action.length);
        const expansion = input.slice(nameStart + name.length).trim();
        if (expansion.length === 0) {
          return { kind: 'error', text: `set 需要展开串。\n\n${USAGE}` };
        }
        store[name] = {
          expansion,
          ...(flags.has('--text') ? { kind: 'text' } : {}),
          ...(flags.has('--confirm') ? { confirm: true } : {}),
        };
        saveAliases(file, store);
        const params = parseParams(expansion);
        return {
          kind: 'success',
          text:
            `已保存${toWorkspace ? '工作区' : '全局'}别名 "${name}"` +
            `${flags.has('--text') ? '（文本预字符串）' : ''}${flags.has('--confirm') ? '（执行前需审批）' : ''}。` +
            (params.length > 0 ? `\n参数：${params.map((p) => (p.default !== undefined ? `<${p.name}=${p.default}>` : `<${p.name}>`)).join(' ')}` : '') +
            '\n模型会在下一步的提示词中看到它，之后可通过 run_command 使用。',
        };
      }

      return { kind: 'error', text: `未知操作：${action}\n\n${USAGE}` };
    },
  }));
}
