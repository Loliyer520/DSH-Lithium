// Module: repeat-detector — watches shell tool results and appends an
// alias suggestion when the model keeps retyping the same long command prefix.
import { expandCommand, loadMergedAliases, sessionCwd } from './store.js';

const MAX_AGENTS = 50;
const MAX_SIGNATURES_PER_AGENT = 300;

/**
 * Command signature: the first `tokenCount` whitespace-separated tokens,
 * whitespace-normalized. Long enough to identify "the same ssh prefix",
 * short enough to survive changing trailing arguments.
 */
function signatureOf(command, tokenCount) {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0].length === 0) return undefined;
  return tokens.slice(0, tokenCount).join(' ');
}

/**
 * @param ctx plugin context
 * @param env shared environment: { storagePath, shellTools, repeatDetector }
 */
export function registerRepeatDetector(ctx, env) {
  const cfg = {
    minPrefixChars: 24,
    prefixTokens: 3,
    threshold: 2,
    ...(env.repeatDetector ?? {}),
  };
  const watchedTools = new Set([...env.shellTools, 'run_command']);
  /** @type {Map<string, Map<string, { count: number, suggested: boolean }>>} */
  const perAgent = new Map();

  function agentStats(agent) {
    const key = agent && typeof agent.id === 'string' ? agent.id : '(anonymous)';
    let stats = perAgent.get(key);
    if (stats === undefined) {
      if (perAgent.size >= MAX_AGENTS) {
        const oldest = perAgent.keys().next().value;
        perAgent.delete(oldest);
      }
      stats = new Map();
      perAgent.set(key, stats);
    }
    return stats;
  }

  ctx.on('tools/post-execute', async function (exec, result, next) {
    if (!watchedTools.has(exec.name)) return next();
    if (result.isError) return next();
    const args = exec.arguments;
    if (!args || typeof args.command !== 'string') return next();
    const command = args.command.trim();
    if (command.length < cfg.minPrefixChars) return next();

    // A run_command call that already expanded an alias is the desired end
    // state, not a repetition problem.
    if (exec.name === 'run_command') {
      try {
        const { merged } = loadMergedAliases(env.storagePath, sessionCwd(exec));
        if (expandCommand(command, merged).applied.length > 0) return next();
      } catch {
        /* fall through: treat as a plain command */
      }
    }

    const signature = signatureOf(command, cfg.prefixTokens);
    if (signature === undefined) return next();

    const stats = agentStats(exec.agent);
    let entry = stats.get(signature);
    if (entry === undefined) {
      if (stats.size >= MAX_SIGNATURES_PER_AGENT) {
        const oldest = stats.keys().next().value;
        stats.delete(oldest);
      }
      entry = { count: 0, suggested: false };
      stats.set(signature, entry);
    }
    entry.count += 1;

    if (entry.count < cfg.threshold || entry.suggested) return next();
    entry.suggested = true;

    // Deliberately no command fingerprint here: the prefix may embed secrets,
    // and the model can see its own earlier commands in context anyway.
    const hint = {
      type: 'text',
      text:
        `[Lithium] Repetition detected: ${entry.count} commands in this session share the same ${cfg.prefixTokens}-token prefix. ` +
        'If that prefix is stable, save it once with command_alias(action: "set", name: <short_name>, expansion: <the repeated prefix>) ' +
        'and run future commands as run_command(command: \'<short_name> <rest>\', ...). ' +
        'The expansion is stored outside the session log, which also keeps any embedded secrets out of future prompts.',
    };
    return { kind: 'accept', content: [...result.content, hint] };
  });
}
