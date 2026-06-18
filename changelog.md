<!--
## [Unreleased]

### Added

### Fixed

### Changed

### Removed
-->

## [1.4.0]

### Added

- **New API events**: Added `render` events to the `ChaosGame` class to notify main-thread listeners when a rendering frame finishes drawing or a download blob is finalized.

## [1.2.0]

### Fixed

- **Race condition**: Safely pause the simulation to prevent a race condition with `transferToImageBitmap`

## [1.1.0]

### Added

- **Default setting values**: Added default setting values for each setting.

### Fixed

- **Setting values not initialized**: Fixed the issue with setting values being undefined