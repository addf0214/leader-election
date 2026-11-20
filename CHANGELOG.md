# Changelog

## [2.0.0] - 2026-11-20

### Changed

- Upgrade `@kubernetes/client-node` from 0.22.x to 2.x, removing the deprecated `request` dependency.
- Require Node.js 22.19.0 or later to match the new SDK's dependencies. CommonJS and ESM usage remain supported.
- Adapt Lease API calls, error handling, and request timeouts to the new SDK. The public API and Watch-based election behavior remain unchanged.

## [1.1.0] - 2026-11-17

### Compatibility

- Requires Node.js 20.16.0 or later, replacing the previously documented Node.js 14 minimum. This release remains on 1.x but raises the runtime requirement.
- Continues to use `@kubernetes/client-node` 0.22.x.
- Calling `initialize()` more than once per instance now rejects.

### Fixed

- Renew leases independently of Watch events and revoke leadership when the last confirmed lease expires. Lease API requests now have a timeout.
- Prevent stale Watch events and late request callbacks from restoring leadership or postponing renewal after re-election.
- Make `awaitLeadership` wait for actual leadership and reject if shutdown happens first.
- Make `gracefulShutdown()` public, stop timers and Watch, remove signal listeners, and emit `leaderLost` before attempting release.
- Distinguish instances sharing a hostname with a random identity suffix.
- Validate renewal intervals and round lease durations up to whole seconds.
- Register event listeners before initialization in the README example.

### Changed

- Refresh dependencies and update compiler configuration for TypeScript 6.
- Simplify error handling, retry logic, and documentation.
- Standardize on the MIT license and include a `LICENSE` file.

### Added

- Regression tests for election, renewal, expiry, Watch handling, shutdown, initialization, and SDK request timeouts.

Shutdown does not wait for election or renewal requests already in flight; this remains a known limitation.

## [1.0.2] - 2025-07-15

### Fixed

- Type declarations are now correctly generated and exported.

## [1.0.1] - 2025-07-15

### Added

- Support for custom logger via `logger` option. Logger must implement `info`, `debug`, and `error` methods.
- Default logger suppresses `info` and `debug` output, only `error` logs to console.
- README updated with logger usage instructions.

### Changed

- All internal logging now uses the provided logger instead of `console` directly.

## [1.0.0] - 2025-07-15

### Added

- Initial release.
