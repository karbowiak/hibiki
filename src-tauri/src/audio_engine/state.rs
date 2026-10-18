//! Shared atomic state — re-exports from callback module.
//!
//! Shared state lives in `callback::SharedAtomics`. Its preference-admission and
//! output-description mutexes are control-thread-only; the callback never locks.
