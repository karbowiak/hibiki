//! Create, run and release a device stream on the same thread, including non-Send streams.

use crossbeam_channel::{bounded, Sender};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputParams {
    pub sample_rate: u32,
    pub channels: u16,
}

/// Only the shutdown channel crosses threads; the device stream never does.
pub struct OutputThread {
    pub params: OutputParams,
    shutdown: Option<Sender<()>>,
}

impl OutputThread {
    pub fn start<T: 'static>(
        open: impl FnOnce() -> Result<(T, OutputParams), String> + Send + 'static,
    ) -> Result<Self, String> {
        let (ready_tx, ready_rx) = bounded(1);
        let (shutdown, stopped) = bounded::<()>(1);
        std::thread::Builder::new()
            .name("audio-output".into())
            .spawn(move || match open() {
                Ok((stream, params)) => {
                    if ready_tx.send(Ok(params)).is_ok() {
                        let _ = stopped.recv();
                    }
                    drop(stream);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .map_err(|e| format!("failed to spawn audio output thread: {e}"))?;
        let params = ready_rx
            .recv()
            .map_err(|_| "audio output thread failed during startup")??;
        Ok(Self {
            params,
            shutdown: Some(shutdown),
        })
    }
}

impl Drop for OutputThread {
    fn drop(&mut self) {
        // Disconnecting wakes the owner even when startup of another engine task failed.
        self.shutdown.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;
    use std::time::Duration;

    #[test]
    fn a_non_send_stream_is_created_and_dropped_on_its_owner_thread() {
        struct StreamGuard {
            _not_send: Rc<()>,
            closed: Sender<std::thread::ThreadId>,
        }
        impl Drop for StreamGuard {
            fn drop(&mut self) {
                let _ = self.closed.send(std::thread::current().id());
            }
        }
        let (created, creation) = bounded(1);
        let (closed, closure) = bounded(1);
        let params = OutputParams {
            sample_rate: 48000,
            channels: 2,
        };
        let output = OutputThread::start(move || {
            created.send(std::thread::current().id()).unwrap();
            Ok((
                StreamGuard {
                    _not_send: Rc::new(()),
                    closed,
                },
                params,
            ))
        })
        .unwrap();
        let owner = creation.recv().unwrap();
        assert_ne!(owner, std::thread::current().id());
        assert_eq!(output.params, params);
        assert!(
            closure.try_recv().is_err(),
            "stream must remain open while the engine owns it"
        );
        drop(output);
        assert_eq!(closure.recv_timeout(Duration::from_secs(1)).unwrap(), owner);
    }

    #[test]
    fn startup_errors_are_returned_without_an_output_handle() {
        let result =
            OutputThread::start(|| Err::<((), OutputParams), _>("no output device".into()));
        assert_eq!(result.err().unwrap(), "no output device");
    }
}
