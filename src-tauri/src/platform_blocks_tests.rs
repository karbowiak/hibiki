//! Exercise the compatibility patch against the real macOS Blocks runtime.
use block::ConcreteBlock;
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};

#[test]
fn stack_block_calls_keep_the_native_argument_layout() {
    let block = ConcreteBlock::new(|left: i32, right: i32| left + right);
    assert_eq!(unsafe { block.call((17, 25)) }, 42);
}

#[test]
fn copied_blocks_retain_captures_until_the_final_native_release() {
    struct Probe(Arc<AtomicUsize>);
    impl Drop for Probe {
        fn drop(&mut self) { self.0.fetch_add(1, Ordering::SeqCst); }
    }
    let dropped = Arc::new(AtomicUsize::new(0));
    let probe = Probe(dropped.clone());
    let block = ConcreteBlock::new(move |value: i32| {
        let _capture = &probe;
        value + 1
    });
    let heap = block.copy();
    let retained = heap.clone();
    drop(heap);
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    assert_eq!(unsafe { retained.call((41,)) }, 42);
    drop(retained);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}
