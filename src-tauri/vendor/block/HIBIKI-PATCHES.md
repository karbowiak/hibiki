# block 0.1.6 compatibility patch

Source: published `block` 0.1.6 by Steven Sheldon, licensed MIT.

Replace the uninhabited `Class` placeholder with the actual 32-pointer storage
used by `_NSConcreteStackBlock`. Only its address is used; the block layout,
public API, copy/dispose routines and callback ownership are unchanged.

Make the previously implicit C calling convention explicit at each foreign
declaration and callback type as well.

This fixes Rust future-incompatibility warning `uninhabited_static` instead of
suppressing it. The remaining application dependency comes through Souvlaki's
macOS media controls and Cocoa. Remove this patch when that dependency migrates.

- [Blocks runtime declaration](https://github.com/llvm/llvm-project/blob/main/compiler-rt/lib/BlocksRuntime/Block_private.h)
- [Rust tracking issue](https://github.com/rust-lang/rust/issues/74840)
- [Original package](https://crates.io/crates/block/0.1.6)

The published crate omits its old Objective-C test-utility path dependency.
That unavailable development dependency is removed from this vendored manifest;
Hibiki exercises stack/copy/capture/drop behavior against macOS's real runtime.
