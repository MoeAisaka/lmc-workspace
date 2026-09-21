/** JSON string literals embedded in HTML must also escape the HTML parser's
 * script terminator, even when it occurs inside a JavaScript string. */
export function scriptJson(value: string): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}
