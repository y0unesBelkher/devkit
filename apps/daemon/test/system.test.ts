import { describe, expect, test } from 'bun:test';
import { parseAppendWindowsPath, parseOsRelease } from '../src/system.ts';

describe('parseOsRelease', () => {
  test('reads quoted and unquoted values', () => {
    const os = parseOsRelease('NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n');
    expect(os).toEqual({ NAME: 'Ubuntu', VERSION_ID: '24.04', ID: 'ubuntu', PRETTY_NAME: 'Ubuntu 24.04.4 LTS' });
  });
});

describe('parseAppendWindowsPath', () => {
  test('defaults to true when unset', () => {
    expect(parseAppendWindowsPath('[boot]\nsystemd=true\n')).toBe(true);
  });

  test('reads false from the interop section', () => {
    expect(parseAppendWindowsPath('[boot]\nsystemd=true\n\n[interop]\nappendWindowsPath = false # no leaks\n')).toBe(false);
  });

  test('ignores the key outside the interop section', () => {
    expect(parseAppendWindowsPath('[boot]\nappendWindowsPath=false\n')).toBe(true);
  });
});
