import { describe, expect, test } from 'bun:test';
import { compareVersions, mergeReleases, parseCandidates, parseFpmPackages } from '../src/services/php-versions.ts';

describe('PHP versions from apt', () => {
  test('finds FPM packages only', () => {
    const pkgnames = ['php8.5-fpm', 'php8.5-cli', 'php8.10-fpm', 'php-fpm', 'php7.4-fpm', 'php8.5-fpm-dbgsym'].join('\n');
    expect(parseFpmPackages(pkgnames)).toEqual(['8.5', '8.10', '7.4']);
  });

  test('reads candidates and skips packages with none', () => {
    const policy = [
      'php8.5-fpm:',
      '  Installed: 8.5.12-1+ubuntu24.04.1+deb.sury.org+1',
      '  Candidate: 8.5.12-1+ubuntu24.04.1+deb.sury.org+1',
      '  Version table:',
      'php8.6-fpm:',
      '  Installed: (none)',
      '  Candidate: 8.6.0~rc3-1+ubuntu24.04.1+deb.sury.org+1',
      'php8.0-fpm:',
      '  Installed: (none)',
      '  Candidate: (none)',
    ].join('\n');
    expect([...parseCandidates(policy)]).toEqual([
      ['8.5', '8.5.12-1+ubuntu24.04.1+deb.sury.org+1'],
      ['8.6', '8.6.0~rc3-1+ubuntu24.04.1+deb.sury.org+1'],
    ]);
  });

  test('merges with the baseline, sorted numerically, flagging pre-releases', () => {
    const candidates = new Map([
      ['8.6', '8.6.0~rc3-1'],
      ['8.10', '8.10.0~beta1-1'],
      ['8.5', '8.5.12-1'],
    ]);
    expect(mergeReleases(['8.4', '8.5'], candidates)).toEqual([
      { version: '8.4', preRelease: false },
      { version: '8.5', preRelease: false },
      { version: '8.6', preRelease: true },
      { version: '8.10', preRelease: true },
    ]);
  });

  test('compares versions numerically', () => {
    expect(['8.10', '8.2', '9.0', '8.5'].sort(compareVersions)).toEqual(['8.2', '8.5', '8.10', '9.0']);
  });
});
