//! Reusable PCM mailboxes: the render callback only copies into spare storage.
use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError};

const SAMPLES: usize = 4096;
const BUFFERS: usize = 16;
pub struct VisSender {
    ready: Sender<Vec<f32>>,
    spare: Receiver<Vec<f32>>,
    recycle: Sender<Vec<f32>>,
}
pub struct VisReceiver {
    ready: Receiver<Vec<f32>>,
    recycle: Sender<Vec<f32>>,
}
pub fn channel() -> (VisSender, VisReceiver) {
    let (ready_tx, ready) = bounded(BUFFERS);
    let (recycle, spare) = bounded(BUFFERS);
    for _ in 0..BUFFERS {
        recycle.try_send(Vec::with_capacity(SAMPLES)).unwrap();
    }
    (VisSender {ready:ready_tx,spare,recycle:recycle.clone()},VisReceiver {ready,recycle})
}
impl VisSender {
    pub fn send(&self, data: &[f32]) {
        let Ok(mut buffer) = self.spare.try_recv() else { return };
        buffer.clear();
        // The visualizer only needs the newest FFT window. Large device blocks
        // cannot grow a mailbox or allocate/drop a fresh vector on the callback.
        buffer.extend_from_slice(&data[data.len().saturating_sub(SAMPLES)..]);
        if let Err(error) = self.ready.try_send(buffer) {
            let _ = self.recycle.try_send(error.into_inner());
        }
    }
}
impl VisReceiver {
    pub fn try_recv(&self) -> Result<Vec<f32>, TryRecvError> { self.ready.try_recv() }
    pub fn recycle(&self, buffer: Vec<f32>) { let _ = self.recycle.try_send(buffer); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_mailboxes_drop_frames_and_recycled_storage_is_reused() {
        let (sender, receiver) = channel();
        for _ in 0..BUFFERS { sender.send(&[0.5;SAMPLES+100]); }
        sender.send(&[0.9;10]);
        let mut pointers = Vec::new();
        for _ in 0..BUFFERS {
            let buffer = receiver.try_recv().unwrap();
            assert_eq!(buffer.len(),SAMPLES);
            assert_eq!(buffer[0],0.5);
            pointers.push(buffer.as_ptr());
            receiver.recycle(buffer);
        }
        assert!(receiver.try_recv().is_err());
        for _ in 0..BUFFERS { sender.send(&[0.2;10]); }
        for pointer in pointers {
            let buffer = receiver.try_recv().unwrap();
            assert_eq!(buffer.as_ptr(),pointer);
            assert_eq!(buffer.len(),10);
            assert_eq!(buffer[0],0.2);
        }
    }
}
