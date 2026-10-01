// Module: aliases — command_alias / run_command tools, confirm guard, prompt section.
import {
  ALIAS_NAME_RE,
  expandCommand,
  loadAliases,
  loadMergedAliases,
  parseParams,
  publicView,
  renderShellValue,
  saveAliases,
  sessionCwd,
  workspaceStoragePath,
} from './store.js';

const JSON_OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

function requireName(args) {
  if (typeof args.name !== 'string' || args.name.length === 0) {
    throw new Error(`action "${args.action}" requires a name`);
  }
}

/**
 * @param ctx plugin context
 * @param env shared environment from index.js: { storagePath, shellTools, modules }
 */
export function registerAliases(ctx, env) {
  const { storagePath } = env;
  const preferredShellTools = env.shellTools;

  function resolveShellTool() {
    for (const toolName of preferredShellTools) {
      const tool = ctx.tools.get(toolName);
      if (tool) return { toolName, tool };
    }
    return undefined;
  }

  // --- command_alias: manage the alias map -------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'command_alias',
    description:
      'Manage reusable command aliases and text presets (named shortcut strings, e.g. a long ssh connection prefix) used by the run_command tool. ' +
      'Actions: "set" stores or replaces an alias (requires name and expansion; optional description, kind, confirm, scope); ' +
      '"remove" deletes an alias (requires name; scope selects which store, default global); ' +
      '"get" shows one alias including its expansion (requires name); "list" shows every alias without expansions. ' +
      'Aliases persist across sessions. Expansions may contain secrets such as passwords: store them here instead of repeating them in shell commands, ' +
      'and never print an expansion in chat unless the user explicitly asks. ' +
      'An expansion may declare <name> or <name=default> parameters; callers pass values as key=value right after the alias token. ' +
      'kind "text" marks a prompt/text preset: it is fetched with "get" and used in replies, and never expands inside run_command. ' +
      'confirm: true makes run_command ask the user for approval before executing that alias. ' +
      'scope "workspace" stores the alias in <workspace>/.dsh/command-aliases.json (project-specific, shadows a global alias of the same name); ' +
      'the default scope "global" stores it in the profile for all projects.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'remove', 'get', 'list'],
          description: 'The operation to perform.',
        },
        name: {
          type: 'string',
          description: 'Alias name: letters, digits, "_" and "-", starting with a letter or "_". Required for set/remove/get.',
        },
        expansion: {
          type: 'string',
          description: 'The full string the alias expands to; may contain <name> or <name=default> parameters. Required for set.',
        },
        description: {
          type: 'string',
          description: 'Optional human/model-facing note about what the alias does. Shown in list and in the system prompt; never include secrets here.',
        },
        kind: {
          type: 'string',
          enum: ['command', 'text'],
          description: 'For set: "command" (default) expands inside run_command; "text" is a prompt/text preset fetched with get.',
        },
        confirm: {
          type: 'boolean',
          description: 'For set: when true, run_command asks the user for approval before executing this alias.',
        },
        scope: {
          type: 'string',
          enum: ['global', 'workspace'],
          description: 'For set/remove: which store to write. "global" (default) is profile-wide; "workspace" lives in the current project and shadows global names.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: (args) => args.action === 'list' || args.action === 'get',
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const workspaceFile = cwd ? workspaceStoragePath(cwd) : undefined;
      const { merged, global: globalAliases, workspace: workspaceAliases } =
        loadMergedAliases(storagePath, cwd);
      switch (args.action) {
        case 'list': {
          const rows = [
            ...Object.entries(globalAliases).map(([n, e]) => publicView(n, e, 'global')),
            ...Object.entries(workspaceAliases).map(([n, e]) => publicView(n, e, 'workspace')),
          ];
          return {
            globalStore: storagePath,
            workspaceStore: workspaceFile ?? '(no workspace)',
            count: rows.length,
            aliases: rows,
          };
        }
        case 'get': {
          requireName(args);
          const entry = merged[args.name];
          if (!entry) throw new Error(`alias "${args.name}" is not defined`);
          const scope = workspaceAliases[args.name] ? 'workspace' : 'global';
          return { ...publicView(args.name, entry, scope), expansion: entry.expansion };
        }
        case 'set': {
          requireName(args);
          if (!ALIAS_NAME_RE.test(args.name)) {
            throw new Error(`invalid alias name ${JSON.stringify(args.name)}: use letters, digits, "_" and "-", starting with a letter or "_"`);
          }
          if (typeof args.expansion !== 'string' || args.expansion.trim().length === 0) {
            throw new Error('action "set" requires a non-empty expansion string');
          }
          if (args.name === 'run_command' || args.name === 'command_alias') {
            throw new Error(`"${args.name}" collides with a tool name; choose another alias`);
          }
          const toWorkspace = args.scope === 'workspace';
          if (toWorkspace && workspaceFile === undefined) {
            throw new Error('no session workspace available; use scope "global"');
          }
          const file = toWorkspace ? workspaceFile : storagePath;
          const store = loadAliases(file);
          const existed = args.name in store;
          store[args.name] = {
            expansion: args.expansion,
            ...(typeof args.description === 'string' && args.description.length > 0
              ? { description: args.description }
              : {}),
            ...(args.kind === 'text' ? { kind: 'text' } : {}),
            ...(args.confirm === true ? { confirm: true } : {}),
          };
          saveAliases(file, store);
          const params = parseParams(args.expansion);
          return {
            ok: true,
            name: args.name,
            scope: toWorkspace ? 'workspace' : 'global',
            kind: args.kind === 'text' ? 'text' : 'command',
            updated: existed,
            parameters: params.map((p) => (p.default !== undefined ? `<${p.name}=${p.default}>` : `<${p.name}>`)),
            hint: args.kind === 'text'
              ? `Fetch it with command_alias(action: "get", name: "${args.name}") and use the text in your reply.`
              : params.length > 0
                ? `Use it through run_command with key=value arguments, e.g. run_command(command: '${args.name} ${params[0].name}=value', description: '...')`
                : `Use it through run_command, e.g. run_command(command: '${args.name} "ls -la"', description: '...')`,
          };
        }
        case 'remove': {
          requireName(args);
          const toWorkspace = args.scope === 'workspace';
          const file = toWorkspace ? workspaceFile : storagePath;
          if (file === undefined) throw new Error('no session workspace available; use scope "global"');
          const store = loadAliases(file);
          if (!(args.name in store)) {
            const where = toWorkspace ? 'workspace' : 'global';
            const shadowed = !toWorkspace && workspaceAliases[args.name] !== undefined;
            throw new Error(`alias "${args.name}" is not defined in the ${where} store${shadowed ? ' (a workspace alias with this name exists; pass scope: "workspace")' : ''}`);
          }
          delete store[args.name];
          saveAliases(file, store);
          return { ok: true, removed: args.name, scope: toWorkspace ? 'workspace' : 'global' };
        }
        default:
          throw new Error(`unknown action ${JSON.stringify(args.action)}`);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: args.action === 'set' || args.action === 'remove' ? 'execute' : 'read',
      title: `command_alias ${args.action}${typeof args.name === 'string' ? ` ${args.name}` : ''}`,
    }),
  }));

  // --- run_command: pwsh/bash with alias expansion ------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'run_command',
    description:
      'Execute a shell command exactly like the pwsh tool (same parameters, sandbox, background-job support), but any standalone alias token in `command` ' +
      'is first replaced by the expansion stored with the command_alias tool. Prefer this over pwsh whenever the command uses a defined alias, ' +
      'e.g. run_command(command: \'remote_shell "systemctl status nginx"\', description: \'Check nginx on the remote server\'). ' +
      'Parameterized aliases take key=value arguments right after the alias token: run_command(command: \'deploy env=staging branch=main\', ...). ' +
      'Use command_alias(action: "list") to see the available aliases and their parameters. Commands without any alias token behave identically to pwsh.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute; standalone alias tokens (with optional key=value parameter assignments) are expanded before execution.',
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
        },
        workdir: {
          type: 'string',
          description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds. On expiry the command moves to a background job instead of being killed.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill).',
        },
        sandbox_permissions: {
          type: 'string',
          enum: ['workspace-write', 'danger-full-access'],
          description: 'The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.',
        },
        justification: {
          type: 'string',
          description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
        },
      },
      required: ['command', 'description'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderShellValue(value) }],
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('invalid command: expected a non-empty string');
      }
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string');
      }
      const resolved = resolveShellTool();
      if (!resolved) {
        throw new Error(`no shell tool available (looked for: ${preferredShellTools.join(', ')})`);
      }
      const { merged } = loadMergedAliases(storagePath, sessionCwd(exec));
      const { command } = expandCommand(args.command, merged);
      // Delegate to the real shell tool so sandbox policy, approval, workdir
      // resolution, environment, and background jobs behave exactly as a
      // direct pwsh/bash call. The expansion stays out of the session log:
      // only the alias form in `args` is recorded.
      return resolved.tool.execute({ ...args, command }, exec);
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: typeof args.command === 'string' ? args.command : 'run_command',
      description: typeof args.description === 'string' ? args.description : undefined,
      ...(typeof args.workdir === 'string' ? { cwd: args.workdir } : {}),
    }),
    presentResult: (args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined;
      if (!block || block.type !== 'text') return undefined;
      const raw = block.text;
      const isBackground = typeof args === 'object' && args !== null && args.run_in_background === true;
      if (isBackground || result.isError) {
        return {
          card: 'generic',
          content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }],
        };
      }
      const match = /([\s\S]*?)\n?\[exit code: (\d+)\]\n?$/.exec(raw);
      if (match) {
        return { card: 'terminal', output: match[1].replace(/\n+$/, ''), exitCode: Number(match[2]) };
      }
      return { card: 'terminal', output: raw.replace(/\n+$/, '') };
    },
  }));

  // --- confirm-guarded aliases: require user approval ----------------------
  ctx.on('tools/pre-execute', async function (exec, next) {
    if (exec.name !== 'run_command') return next();
    const args = exec.arguments;
    if (!args || typeof args.command !== 'string') return next();
    let applied;
    let merged;
    try {
      ({ merged } = loadMergedAliases(storagePath, sessionCwd(exec)));
      ({ applied } = expandCommand(args.command, merged));
    } catch {
      return next(); // expansion errors are reported by run_command itself
    }
    const flagged = applied.filter((n) => merged[n] && merged[n].confirm === true);
    if (flagged.length === 0) return next();
    return {
      kind: 'ask',
      reason: `run_command uses confirm-guarded alias(es): ${flagged.join(', ')}. Approve to expand and execute.`,
    };
  });

  // --- system prompt section: current aliases + usage ---------------------
  if (env.modules.promptSection !== false) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'lithium-aliases',
      order: 1000,
      text: () => {
        const { global: globalAliases } = loadMergedAliases(storagePath, undefined);
        const names = Object.keys(globalAliases);
        const lines = [
          '## Command aliases (Lithium plugin)',
          '',
          'Reusable named command strings and text presets are available. Manage them with the `command_alias` tool ' +
          '(actions: set / remove / get / list) and run command aliases with the `run_command` tool, which accepts the same parameters ' +
          'as `pwsh` but replaces every standalone alias token in `command` with its stored expansion before execution.',
          '',
          'Example: after command_alias(action: "set", name: "remote_shell", expansion: "sshpass -p \'…\' ssh user@host"), ' +
          'run_command(command: \'remote_shell "df -h"\', description: "Check remote disk usage") executes the full ssh command.',
          '',
          'Features:',
          '- Parameters: an expansion may contain <name> or <name=default> placeholders. Pass values as key=value right after the alias token, ' +
          'e.g. run_command(command: \'deploy env=staging branch=main\', ...). Missing required parameters fail the call with the parameter list.',
          '- Scopes: aliases live in a global profile store and, when set with scope: "workspace", in <workspace>/.dsh/command-aliases.json. ' +
          'Workspace aliases shadow global ones of the same name. command_alias(action: "list") shows both scopes; the list below only shows global aliases.',
          '- Text presets: aliases with kind "text" are prompt/text snippets. Fetch them with command_alias(action: "get") and use the content ' +
          'in your reply or reasoning; they never expand inside run_command.',
          '- Confirm-guarded aliases (confirm: true) ask the user for approval before run_command executes them.',
          '',
          'Rules:',
          '- Alias expansions may contain secrets (passwords, tokens). Never print or quote an expansion in chat; refer to the alias by name.',
          '- Alias tokens only expand inside `run_command`, not inside `pwsh` or other tools.',
          '- When the user mentions a machine, service, or command prefix that matches a listed alias, use that alias instead of retyping the full command.',
          '- When a repetition hint appears inside a tool result, treat it as a strong signal: propose or create the alias it suggests.',
          '- Proactively watch for repetition yourself: if you catch yourself typing the same long command or prefix (such as an ssh/sshpass connection ' +
          'string, a docker exec line, or a kubectl context) a second time — in this session or because the user keeps pasting it — stop and ' +
          'suggest saving it as an alias ("This command keeps repeating; shall I save it as alias X?"). With the user\'s confirmation, or when ' +
          'the user asked you to set up aliases in the first place, call command_alias(action: "set", ...) and use run_command from then on.',
          '- When the user pastes a command containing credentials, offer to store it as an alias so the secret stays out of future prompts and logs.',
        ];
        if (names.length === 0) {
          lines.push('', 'No global aliases are defined yet (workspace aliases may still exist; use command_alias(action: "list") to check).');
        } else {
          lines.push('', 'Currently defined global aliases (expansions hidden):');
          for (const aliasName of names.sort()) {
            const entry = globalAliases[aliasName];
            const params = parseParams(entry.expansion);
            const bits = [
              entry.kind === 'text' ? 'text preset' : undefined,
              entry.confirm === true ? 'confirm-guarded' : undefined,
              params.length > 0 ? `params: ${params.map((p) => (p.default !== undefined ? `<${p.name}=${p.default}>` : `<${p.name}>`)).join(' ')}` : undefined,
              entry.description,
            ].filter(Boolean);
            lines.push(`- ${aliasName}${bits.length > 0 ? `: ${bits.join('; ')}` : ''}`);
          }
        }
        return lines.join('\n');
      },
    }));
  }
}
