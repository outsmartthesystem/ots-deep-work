/**
 * @jest-environment jsdom
 */
const { sanitizeBlueprintHTML } = require('../shared');

describe('sanitizeBlueprintHTML', () => {
  test('removes <script> but keeps its text', () => {
    const out = sanitizeBlueprintHTML('<div>hi<script>alert(1)</script></div>');
    expect(out).not.toContain('<script');
    expect(out).toContain('hi');
  });

  test('neutralizes a disallowed tag with an event handler (img onerror)', () => {
    const out = sanitizeBlueprintHTML('<p>before<img src=x onerror="alert(1)">after</p>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror');
  });

  test('strips javascript: hrefs but keeps https links', () => {
    const bad = sanitizeBlueprintHTML('<a href="javascript:alert(1)">x</a>');
    expect(bad).not.toContain('javascript:');
    const good = sanitizeBlueprintHTML('<a href="https://cal.com/jay">book</a>');
    expect(good).toContain('https://cal.com/jay');
  });

  test('keeps allowlisted tags, classes, and the download button', () => {
    const html = '<div class="blueprint-container"><h2 class="blueprint-section-header">Who You Are</h2>' +
      '<button class="download-btn">Download</button></div>';
    const out = sanitizeBlueprintHTML(html);
    expect(out).toContain('blueprint-container');
    expect(out).toContain('blueprint-section-header');
    expect(out).toContain('download-btn');
  });

  test('drops event-handler attributes but keeps the element', () => {
    const out = sanitizeBlueprintHTML('<div class="x" onclick="steal()">body</div>');
    expect(out).toContain('class="x"');
    expect(out).not.toContain('onclick');
    expect(out).toContain('body');
  });

  test('filters inline style to the allowlisted properties only', () => {
    const out = sanitizeBlueprintHTML('<p style="color: red; position: fixed; behavior: url(x)">t</p>');
    expect(out).toContain('color: red');
    expect(out).not.toContain('position');
    expect(out).not.toContain('behavior');
  });
});
