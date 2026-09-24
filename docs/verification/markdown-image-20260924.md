# Local Markdown image previews

Web v185; existing Agent resource-file capability is reused.

## Failure and fix

The assistant emitted an image destination such as
`![Preview](</Volumes/Work Disk/project/preview.png>)`. The Markdown renderer
passed that local host path, including angle brackets, directly to the browser.
The result was a persistent gray placeholder on another device.

Local image destinations now load through the owning session's encrypted
`resource-file` RPC. Both engines use the same advertised capability. The client
unwraps Markdown destinations, decodes file URLs, validates chunk sizes and
revisions, and joins decoded bytes before constructing the image URI. HTTP and
data images retain their direct rendering path. Failures offer retry; legacy
Agents show the existing refresh/upgrade explanation. Late results from a prior
session cannot replace the current image.

## Evidence

- The actual exported v184 renderer failed the new browser check with the
  caption present, no page errors, no image and no file RPC calls.
- 21 targeted tests passed, including bracketed paths, base64 chunk padding,
  separate sessions, invalid cursors, file size limits, revision changes and
  recovery after a failed read. App typecheck and production export passed.
- `scripts/markdown-image-smoke/verify.cjs` passed against the candidate export
  for both engine fixtures, file and HTTP images, retry, legacy capability
  fallback and light/dark layouts at 390 and 1200 pixels. It uses actual Metro
  modules with local fixtures and blocks external network requests.
- The reported preview was read through its real session's read-only resource
  RPC: all 87,597 bytes were returned and matched the original file. The PNG
  rendered successfully in the mobile-width browser check.

No business session received test input or was restarted. No full-repository
test run or physical iPhone browser check was performed.
