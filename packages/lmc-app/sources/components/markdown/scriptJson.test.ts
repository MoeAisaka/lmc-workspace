import { expect, it } from 'vitest';
import { scriptJson } from './scriptJson';

it('preserves diagram text without permitting an HTML script terminator', () => {
    const text = 'graph TD; A-->B\n</ScRiPt><script>throw new Error("injected")</script><!--';
    const literal = scriptJson(text);
    expect(literal).not.toContain('<');
    expect(JSON.parse(literal)).toBe(text);
});
