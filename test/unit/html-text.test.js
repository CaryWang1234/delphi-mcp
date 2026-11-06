import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, decodeEntities, clip } from '../../src/tools.js';

test('block tags become line breaks and inline tags disappear', () => {
  const text = htmlToText('<p>First <strong>bold</strong> bit.</p><p>Second <a>line</a></p>');
  assert.equal(text, 'First bold bit.\n\nSecond line');
});

test('<br> splits lines without leaving stray whitespace', () => {
  assert.equal(htmlToText('one<br>two<br/>three'), 'one\ntwo\nthree');
});

test('relative links are resolved to absolute URLs', () => {
  const text = htmlToText('<a href="/t/topic/123">the thread</a>');
  assert.match(text, /^the thread \(https?:\/\/[^/]+\/t\/topic\/123\)$/);
});

test('a link whose label is the URL is not duplicated', () => {
  const text = htmlToText('<a href="https://example.com/x">https://example.com/x</a>');
  assert.equal(text, 'https://example.com/x');
});

test('a link inside a paragraph survives both the URL pass and tag stripping', () => {
  const text = htmlToText('<p>See <a href="https://example.com/a?x=1&amp;y=2">the docs</a> for more.</p>');
  assert.equal(text, 'See the docs (https://example.com/a?x=1&y=2) for more.');
});

test('code blocks keep their lines and lose their markup', () => {
  const text = htmlToText('<pre><code>int x = 1;\nif (x &gt; 0) {\n  a |= b;\n}</code></pre>');
  assert.match(text, /```\nint x = 1;\nif \(x > 0\) \{/);
  assert.doesNotMatch(text, /<code>/);
});

test('images become a labelled URL instead of being dropped', () => {
  const text = htmlToText('<img src="/uploads/default/original/3X/a/abc.png" alt="diagram">');
  assert.match(text, /\[image: https?:\/\/[^/]+\/uploads\/default\/original\/3X\/a\/abc\.png\]/);
});

test('named, decimal and hex entities all decode', () => {
  assert.equal(decodeEntities('a &amp; b &lt; c &gt; d &quot;e&quot;'), 'a & b < c > d "e"');
  assert.equal(decodeEntities('BIOCORE&#8482;'), 'BIOCORE™');
  assert.equal(decodeEntities('x&#x2014;y'), 'x—y');
  assert.equal(decodeEntities('&nosuchentity;'), '&nosuchentity;', 'unknown entities stay literal');
});

test('ampersands inside a code block are decoded exactly once', () => {
  const text = htmlToText('<pre><code>a &amp;&amp; b</code></pre>');
  assert.match(text, /a && b/);
});

test('runs of blank lines collapse to one separator', () => {
  const text = htmlToText('<p>one</p><p></p><p></p><p></p><p>two</p>');
  assert.doesNotMatch(text, /\n{3,}/);
});

test('clip leaves the original untouched below the limit', () => {
  assert.equal(clip('short', 100), 'short');
  assert.equal(clip('x'.repeat(100), 100), 'x'.repeat(100));
});

test('clip truncates and explains how to continue', () => {
  const out = clip('y'.repeat(500), 200);
  assert.ok(out.length < 500);
  assert.match(out, /truncated at 200 of 500 chars/);
  assert.match(out, /max_chars/);
});
