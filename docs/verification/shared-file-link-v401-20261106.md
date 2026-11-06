# Shared transcript file links — v401

Clicking a document path in a shared transcript previously called the owner's host-file RPC, which correctly rejected an operation outside the shared collaboration API. This could fail even when the same document already had an accessible saved-file card.

The frontend now opens the existing saved-file dialog when a path has one uniquely named saved-file card in the same loaded shared transcript. The file action entry point follows the same routing. The saved-file API remains responsible for current recipient authorization; no host-file RPC or account permission is broadened. Owner source-file behavior is unchanged.

Only file-card messages with valid asset IDs participate, including nested cards. Repeated references to one asset are deduplicated. Different assets with the same name are not guessed, and other sessions are never searched. This does not add access to unpublished files, cards outside the loaded message window, or files whose grants have been revoked.

Validation: three engine-specific regression cases failed before implementation; afterward, 25 tests passed across `openFileReference.test.ts`, `savedFileLink.test.ts`, `readSessionResource.test.ts` and `apiFileAssets.test.ts`. TypeScript and the production Expo export passed. The same four changed frontend files were synchronized byte-for-byte to the public mirror after matching their original baselines. Synthetic fixtures contain no real account, filename, host or session data.

Release: `lmc-redesign-20260908-v401`. Published entry assets matched the build hashes. No server, database-schema or Agent release was required. Device-specific browser acceptance remains separate from the automated routing checks.
