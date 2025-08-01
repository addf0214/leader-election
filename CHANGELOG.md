# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
