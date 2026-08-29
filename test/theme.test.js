import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../extension/ui.css', import.meta.url), 'utf8');
const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
const palettes = roots.map(root => Object.fromEntries(
  [...root[1].matchAll(/(--[\w-]+):\s*(#[a-f\d]{3,6})\s*;/gi)].map(match => [match[1], match[2]])
));

function luminance(hex) {
  const value = hex.slice(1);
  const full = value.length === 3 ? [...value].map(c => c + c).join('') : value;
  const rgb = [0, 2, 4].map(start => parseInt(full.slice(start, start + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('both appearance palettes resolve every color used by the shared interface', () => {
  assert.equal(palettes.length, 2);
  const tokens = [...css.matchAll(/var\((--[\w-]+)\)/g)].map(match => match[1]);
  for (const palette of palettes) {
    for (const token of tokens) assert.ok(palette[token], `Missing theme color ${token}`);
  }
});

test('components cannot retain a fixed light-only color outside the palettes', () => {
  const components = css.replace(/:root\s*\{[^}]+\}/g, '');
  assert.doesNotMatch(components, /#[a-f\d]{3,8}\b|(?<![\w-])(?:white|black)(?![\w-])/gi);
});

for (const [index, name] of ['light', 'dark'].entries()) {
  test(`${name} theme maintains at least 4.5:1 contrast for interface text`, () => {
    const palette = palettes[index];
    const pairs = [
      ...['--paper', '--wash', '--inset', '--field', '--hover', '--notice'].map(bg => ['--ink', bg]),
      ...['--paper', '--wash', '--inset', '--field'].map(bg => ['--muted', bg]),
      ['--accent-text', '--paper'], ['--accent-text', '--accent-soft'],
      ['--on-accent', '--wine'], ['--on-accent', '--wine-hover'],
      ['--green', '--paper'], ['--green', '--success-soft'],
      ['--danger', '--paper'], ['--danger', '--hover']
    ];
    for (const [fg, bg] of pairs) {
      const ratio = contrast(palette[fg], palette[bg]);
      assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
    }
  });

  test(`${name} theme keeps control borders and focus indicators visible`, () => {
    const palette = palettes[index];
    for (const foreground of ['--control-border', '--focus', '--button-border']) {
      for (const background of ['--paper', '--wash', '--field']) {
        const ratio = contrast(palette[foreground], palette[background]);
        assert.ok(ratio >= 3, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
      }
    }
  });
}


test('interactive red stays exactly #800000 in both system appearances', () => {
  for (const palette of palettes) {
    assert.equal(palette['--wine'], '#800000');
    assert.equal(palette['--wine-hover'], '#800000');
    assert.ok(contrast(palette['--on-accent'], palette['--wine']) >= 4.5);
  }
});


test('status and action icons share a width while preserving SVG proportions', async () => {
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const indicators = [...html.matchAll(/<span[^>]*id="(?:account-saved|passkey-saved)"[^>]*>([\s\S]*?)<\/span>/g)];
  assert.equal(indicators.length, 2);
  for (const [, content] of indicators) {
    const tag = content.match(/<svg\b([^>]+)>/)[1];
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const [, , width, height] = attrs.viewBox.split(/\s+/).map(Number);
    assert.equal(Number(attrs.width) / Number(attrs.height), width / height);
    assert.notEqual(attrs.preserveAspectRatio, 'none');
  }
  const sharedRule = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .find(([, selector]) => selector.includes('.icon-button svg') && selector.includes('.saved-indicator svg'));
  assert.ok(sharedRule, 'Action and status icons must share sizing.');
  const declarations = Object.fromEntries(sharedRule[2].split(';').filter(part => part.includes(':'))
    .map(part => part.split(':').map(value => value.trim())));
  assert.equal(declarations.width, '18px');
  assert.equal(declarations.height, 'auto');
  assert.equal(declarations.flex, 'none');
});


test('the password and PIN storage locks align with their explanatory text', async () => {
  const html = await readFile(new URL('../extension/settings.html', import.meta.url), 'utf8');
  assert.match(html, /id="password-help"[^>]*hidden/);
  assert.match(html, /class="credential-lock secure-help-lock" aria-hidden="true"/);
  assert.match(html, /id="pin-storage-help"[^>]*hidden/);
  assert.ok(html.indexOf('id="pin-storage-help"') < html.indexOf('id="pin-storage-help-text"'));
  assert.match(html, /id="pin-storage-help-text"><\/span>/);
  assert.match(css, /\.secure-help\s*\{[^}]*display:flex;[^}]*align-items:flex-start;/);
});

test('saved passkey account and current-account label share centered line metrics', () => {
  assert.match(css, /\.credential-title\s*\{[^}]*align-items:center;/);
  assert.match(css, /\.credential-account\s*\{[^}]*line-height:1\.5;/);
  assert.match(css, /\.credential \.credential-label\s*\{[^}]*align-items:center;[^}]*line-height:1\.5;/);
});

test('all interface pages use nonnegative language-specific tracking, including controls', async () => {
  assert.match(css, /:lang\(zh\)\s*\{\s*letter-spacing:\s*0\.04em;\s*\}/);
  assert.match(css, /:lang\(en\)\s*\{\s*letter-spacing:\s*normal;\s*\}/);
  for (const [, value] of css.matchAll(/letter-spacing\s*:\s*([^;}]+)/g)) {
    assert.ok(['normal', '0.04em'].includes(value.trim()), 'Unexpected tracking override: ' + value);
  }
  for (const page of ['settings', 'popup', 'confirm']) {
    const html = await readFile(new URL('../extension/' + page + '.html', import.meta.url), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="ui.css">/);
    assert.match(html, /<strong lang="en-US">UChicago<\/strong>/);
    assert.doesNotMatch(html, /letter-spacing\s*:\s*-/);
  }
  const settings = await readFile(new URL('../extension/settings.html', import.meta.url), 'utf8');
  for (const language of ['en-US', 'zh-CN']) {
    assert.ok(settings.includes('data-language-name="' + language + '" lang="' + language + '"'));
  }
});
