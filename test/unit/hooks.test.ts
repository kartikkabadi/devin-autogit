import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOOK_COMMAND_MARKER,
  installStopHook,
  isOurHookCommand,
  readHooksFile,
  uninstallStopHook,
  writeHooksFile,
  type HooksFile,
} from '../../src/core/hooks.js';
import { ConfigError } from '../../src/core/config.js';

const CMD = 'devin-autogit ship --quiet --json';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'devin-autogit-hooks-')), 'hooks.v1.json');
}

describe('readHooksFile / writeHooksFile', () => {
  it('returns empty object for a missing file', () => {
    expect(readHooksFile(tmpFile())).toEqual({});
  });

  it('round-trips with stable formatting and trailing newline', () => {
    const path = tmpFile();
    const hooks: HooksFile = {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: CMD, timeout: 120 }] }],
    };
    writeHooksFile(path, hooks);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toBe(JSON.stringify(hooks, null, 2) + '\n');
    expect(readHooksFile(path)).toEqual(hooks);
  });

  it('throws ConfigError on invalid JSON', () => {
    const path = tmpFile();
    writeFileSync(path, '{not json');
    expect(() => readHooksFile(path)).toThrow(ConfigError);
  });

  it('throws ConfigError on schema mismatch', () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ Stop: 'nope' }));
    expect(() => readHooksFile(path)).toThrow(ConfigError);
  });
});

describe('installStopHook', () => {
  it('installs a Stop matcher entry with the verified schema shape', () => {
    const { hooks, installed } = installStopHook({}, CMD);
    expect(installed).toEqual(['Stop']);
    expect(hooks).toEqual({
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: CMD, timeout: 120 }] }],
    });
  });

  it('is idempotent', () => {
    const first = installStopHook({}, CMD);
    const second = installStopHook(first.hooks, CMD);
    expect(second.installed).toEqual([]);
    expect(second.hooks).toEqual(first.hooks);
  });

  it('supports multiple events', () => {
    const { hooks, installed } = installStopHook({}, CMD, { events: ['Stop', 'SessionEnd'] });
    expect(installed).toEqual(['Stop', 'SessionEnd']);
    expect(Object.keys(hooks)).toEqual(['Stop', 'SessionEnd']);
  });

  it('preserves existing user hooks and events', () => {
    const user: HooksFile = {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo done' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-lint' }] }],
    };
    const { hooks } = installStopHook(user, CMD);
    expect(hooks['PostToolUse']).toEqual(user['PostToolUse']);
    expect(hooks['Stop']).toHaveLength(2);
    expect(hooks['Stop']?.[0]).toEqual(user['Stop']?.[0]);
  });
});

describe('uninstallStopHook', () => {
  it('removes only our entries and leaves user hooks', () => {
    const user: HooksFile = {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: 'echo done' }] },
        { matcher: '', hooks: [{ type: 'command', command: CMD, timeout: 120 }] },
      ],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-lint' }] }],
    };
    const { hooks, removed } = uninstallStopHook(user);
    expect(removed).toEqual(['Stop']);
    expect(hooks).toEqual({
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo done' }] }],
      PostToolUse: user['PostToolUse'],
    });
  });

  it('drops events that become empty', () => {
    const { hooks: installed } = installStopHook({}, CMD, { events: ['Stop', 'SessionEnd'] });
    const { hooks, removed } = uninstallStopHook(installed);
    expect(removed.sort()).toEqual(['SessionEnd', 'Stop']);
    expect(hooks).toEqual({});
  });

  it('keeps user hooks inside a mixed entry', () => {
    const mixed: HooksFile = {
      Stop: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: 'echo done' },
            { type: 'command', command: CMD },
          ],
        },
      ],
    };
    const { hooks } = uninstallStopHook(mixed);
    expect(hooks['Stop']?.[0]?.hooks).toEqual([{ type: 'command', command: 'echo done' }]);
  });

  it('is a no-op when nothing matches', () => {
    const user: HooksFile = {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo done' }] }],
    };
    const { hooks, removed } = uninstallStopHook(user);
    expect(removed).toEqual([]);
    expect(hooks).toEqual(user);
  });
});

describe('isOurHookCommand', () => {
  it('matches the linked binary and node-path forms', () => {
    expect(isOurHookCommand(CMD)).toBe(true);
    expect(isOurHookCommand('node /abs/dist/cli.js ship --quiet --json')).toBe(true);
    expect(isOurHookCommand('echo done')).toBe(false);
    expect(HOOK_COMMAND_MARKER).toBe('devin-autogit ship');
  });
});
