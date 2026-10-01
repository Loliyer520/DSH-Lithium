// Agent Toolkit — modular entry point.
// Each module is independent and can be toggled via the plugin row's config:
//
//   config: {
//     storagePath: '<absolute path to the global alias store>',   // optional
//     shellTools: ['pwsh', 'bash'],                               // delegation order
//     modules: {
//       aliases: true,         // command_alias + run_command + confirm guard
//       promptSection: true,   // dynamic system-prompt section about aliases
//       repeatDetector: true,  // repetition hints appended to shell results
//       slashCommand: true,    // user-facing /alias command
//     },
//     repeatDetector: { minPrefixChars: 24, prefixTokens: 3, threshold: 2 },
//   }
import { defaultStoragePath } from './modules/store.js';
import { registerAliases } from './modules/aliases.js';
import { registerRepeatDetector } from './modules/repeat-detector.js';
import { registerSlashCommand } from './modules/slash-command.js';

export const name = 'dsh-lithium';
export const inject = ['tools', 'systemPrompt', 'commands'];

export function apply(ctx, config = {}) {
  const env = {
    storagePath: typeof config.storagePath === 'string' && config.storagePath.trim().length > 0
      ? config.storagePath
      : defaultStoragePath(),
    shellTools: Array.isArray(config.shellTools) && config.shellTools.length > 0
      ? config.shellTools.filter((n) => typeof n === 'string')
      : ['pwsh', 'bash'],
    modules: config.modules && typeof config.modules === 'object' ? config.modules : {},
    repeatDetector: config.repeatDetector && typeof config.repeatDetector === 'object'
      ? config.repeatDetector
      : {},
  };

  const enabled = (key) => env.modules[key] !== false;

  if (enabled('aliases')) registerAliases(ctx, env);
  if (enabled('repeatDetector')) registerRepeatDetector(ctx, env);
  if (enabled('slashCommand')) registerSlashCommand(ctx, env);
}
