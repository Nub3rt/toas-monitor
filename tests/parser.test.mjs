import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMonitoredTables } from '../src/parser.ts';

// Minimal event-driven HTMLRewriter stand-in to test selector registration,
// scoped text callbacks, streaming chunks, and end-tag state transitions.
// The actual Workers native parser is used in deployment.
class MockHTMLRewriter {
  handlers = [];

  on(selector, handler) {
    if (selector.includes(',')) throw new Error(`unsupported selector: ${selector}`);
    this.handlers.push({ selector, handler });
    return this;
  }

  transform(response) {
    return {
      text: async () => {
        const html = await response.text();
        const stack = [];
        const tokens = /<\/?[A-Za-z][^>]*>|[^<]+/g;
        for (const match of html.matchAll(tokens)) {
          const token = match[0];
          if (token.startsWith('</')) {
            const tag = token.match(/^<\/([A-Za-z][\w-]*)/)[1].toLowerCase();
            let node;
            do {
              node = stack.pop();
              if (!node) throw new Error(`unbalanced HTML: ${tag}`);
              for (const onEndTag of node.endCallbacks) onEndTag();
            } while (node.tag !== tag);
          } else if (token.startsWith('<')) {
            const tag = token.match(/^<([A-Za-z][\w-]*)/)[1].toLowerCase();
            const node = { tag, endCallbacks: [], handlers: this.handlers.filter((h) => h.selector === tag) };
            stack.push(node);
            for (const { handler } of node.handlers) {
              handler.element?.({ onEndTag: (callback) => node.endCallbacks.push(callback) });
            }
          } else {
            const decoded = token.replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');
            // Split one text node to simulate streaming by HTMLRewriter.
            const middle = Math.max(1, Math.floor(decoded.length / 2));
            const chunks = [decoded.slice(0, middle), decoded.slice(middle)];
            for (const node of stack) {
              for (const { handler } of node.handlers) {
                chunks.forEach((chunk, i) => handler.text?.({ text: chunk, lastInTextNode: i === 1 }));
              }
            }
          }
        }
        if (stack.length) throw new Error('unbalanced mock HTML');
        return html;
      },
    };
  }
}

globalThis.HTMLRewriter = MockHTMLRewriter;

test('only captures the next two tables following the matching heading', async () => {
  const html = `
    <h2>Other section</h2>
    <table><tr><td>Ignore me</td></tr></table>
    <h3>Tenancy agreement <strong>beginning</strong> immediately</h3>
    <table>
      <tr><th>Street</th><th>Size</th></tr>
      <tr><td><span>Mikon</span><span>talo</span>&nbsp;  </td><td>23 &amp; 24 m²</td></tr>
      <tr><td></td><td></td></tr>
    </table>
    <table><tr><th>Address</th></tr><tr><td>Hervanta</td></tr></table>
    <table><tr><td>Ignore this too</td></tr></table>
  `;
  assert.deepEqual(await parseMonitoredTables(html), [
    { headers: ['Street', 'Size'], rows: [['Mikon talo', '23 & 24 m²']] },
    { headers: ['Address'], rows: [['Hervanta']] },
  ]);
});

test('missing heading produces [] even if unrelated tables exist', async () => {
  assert.deepEqual(await parseMonitoredTables('<h2>Other</h2><table><tr><td>Listing</td></tr></table>'), []);
});

test('a heading with no following tables produces []', async () => {
  assert.deepEqual(await parseMonitoredTables('<h2>Tenancy agreement beginning immediately</h2><p>none</p>'), []);
});
