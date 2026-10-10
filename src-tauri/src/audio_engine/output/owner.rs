//! Device recovery with exclusive callback ownership and non-Send device streams.

use super::device_render::{DeviceRenderer, RenderSource};
use crossbeam_channel::{bounded, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputParams {
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceSpec {
    pub name: String,
    pub params: OutputParams,
    pub format: cpal::SampleFormat,
}

/// A callback returns its complete renderer when a device stream is released.
/// The renderer has one owner at a time; no mutex guards its audio state.
pub struct CallbackOwner<S> {
    renderer: Option<DeviceRenderer<S>>,
    returned: Sender<DeviceRenderer<S>>,
}

impl<S: RenderSource> CallbackOwner<S> {
    pub fn new(renderer: DeviceRenderer<S>, returned: Sender<DeviceRenderer<S>>) -> Self {
        Self {
            renderer: Some(renderer),
            returned,
        }
    }
    pub fn render(&mut self, samples: &mut [f32]) {
        if let Some(renderer) = &mut self.renderer {
            renderer.render(samples);
        } else {
            samples.fill(0.0);
        }
    }
}

impl<S> Drop for CallbackOwner<S> {
    fn drop(&mut self) {
        if let Some(renderer) = self.renderer.take() {
            let _ = self.returned.try_send(renderer);
        }
    }
}

/// Constructed and used only by the output owner; Stream deliberately has no Send bound.
pub trait OutputDriver<S: RenderSource> {
    type Stream;
    fn probe(&mut self) -> Result<DeviceSpec, String>;
    /// Even on failure, the callback must be dropped so its renderer is returned.
    fn open(
        &mut self,
        spec: &DeviceSpec,
        callback: CallbackOwner<S>,
        failed: Arc<AtomicBool>,
    ) -> Result<Self::Stream, String>;
    fn availability(&mut self, available: bool);
}

pub struct OutputThread {
    pub params: OutputParams,
    shutdown: Option<Sender<()>>,
}

impl OutputThread {
    pub fn start<S: RenderSource + 'static, D: OutputDriver<S> + 'static>(
        source: S,
        driver: impl FnOnce() -> D + Send + 'static,
    ) -> Result<Self, String> {
        Self::start_with_interval(source, driver, Duration::from_millis(250))
    }

    fn start_with_interval<S: RenderSource + 'static, D: OutputDriver<S> + 'static>(
        source: S,
        driver: impl FnOnce() -> D + Send + 'static,
        interval: Duration,
    ) -> Result<Self, String> {
        let params = source.params();
        let (ready_tx, ready_rx) = bounded(1);
        let (shutdown, stopped) = bounded::<()>(1);
        std::thread::Builder::new()
            .name("audio-output".into())
            .spawn(move || {
                let mut driver = driver();
                let (returned, recovery) = bounded(1);
                let mut failed = Arc::new(AtomicBool::new(false));
                let mut renderer = Some(DeviceRenderer::new(source));
                let mut stream: Option<D::Stream> = None;
                let mut active: Option<DeviceSpec> = None;
                let mut availability = None;
                let _ = ready_tx.send(());
                loop {
                    let candidate = driver.probe();
                    let must_replace = stream.is_some()
                        && (failed.swap(false, Ordering::AcqRel)
                            || candidate.as_ref().ok() != active.as_ref());
                    if must_replace {
                        driver.availability(false);
                        availability = Some(false);
                        stream.take();
                        active = None;
                    }
                    if renderer.is_none() && stream.is_none() {
                        renderer = recovery.try_recv().ok();
                    }
                    if stream.is_none() {
                        if let Some(owned) = &mut renderer {
                            owned.source.poll();
                        }
                        if let Ok(spec) = &candidate {
                            if let Some(mut owned) = renderer.take() {
                                if owned.configure(spec.params).is_ok() {
                                    let callback = CallbackOwner::new(owned, returned.clone());
                                    // Retired stream errors cannot invalidate a replacement.
                                    failed = Arc::new(AtomicBool::new(false));
                                    match driver.open(spec, callback, failed.clone()) {
                                        Ok(opened) => {
                                            stream = Some(opened);
                                            active = Some(spec.clone());
                                        }
                                        Err(_) => {
                                            renderer = recovery.try_recv().ok();
                                        }
                                    }
                                } else {
                                    renderer = Some(owned);
                                }
                            }
                        }
                    }
                    let available = stream.is_some();
                    if availability != Some(available) {
                        driver.availability(available);
                        availability = Some(available);
                    }
                    if stopped.recv_timeout(interval)
                        != Err(crossbeam_channel::RecvTimeoutError::Timeout)
                    {
                        break;
                    }
                }
                drop(stream);
                driver.availability(false);
            })
            .map_err(|error| format!("failed to spawn audio output thread: {error}"))?;
        ready_rx
            .recv()
            .map_err(|_| "audio output thread failed during startup")?;
        Ok(Self {
            params,
            shutdown: Some(shutdown),
        })
    }
}

impl Drop for OutputThread {
    fn drop(&mut self) {
        self.shutdown.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    struct Source {
        frames: Arc<AtomicUsize>,
        paused: Arc<AtomicBool>,
    }
    impl RenderSource for Source {
        fn params(&self) -> OutputParams {
            OutputParams {
                sample_rate: 48000,
                channels: 2,
            }
        }
        fn render(&mut self, samples: &mut [f32]) {
            let paused = self.paused.load(Ordering::Acquire);
            samples.fill(if paused { 0.0 } else { 0.1 });
            if !paused {
                self.frames.fetch_add(samples.len() / 2, Ordering::AcqRel);
            }
        }
        fn poll(&mut self) {}
    }
    struct Stream {
        callback: Rc<RefCell<Option<CallbackOwner<Source>>>>,
        closed: Sender<std::thread::ThreadId>,
    }
    impl Drop for Stream {
        fn drop(&mut self) {
            self.callback.borrow_mut().take();
            let _ = self.closed.send(std::thread::current().id());
        }
    }
    struct Driver {
        device: Arc<Mutex<Option<DeviceSpec>>>,
        callback: Rc<RefCell<Option<CallbackOwner<Source>>>>,
        opened: Sender<std::thread::ThreadId>,
        closed: Sender<std::thread::ThreadId>,
        statuses: Sender<bool>,
        failures: Arc<AtomicUsize>,
    }
    impl OutputDriver<Source> for Driver {
        type Stream = Stream;
        fn probe(&mut self) -> Result<DeviceSpec, String> {
            if let Some(callback) = &mut *self.callback.borrow_mut() {
                callback.render(&mut [0.0; 128]);
            }
            self.device
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "no device".into())
        }
        fn open(
            &mut self,
            _: &DeviceSpec,
            callback: CallbackOwner<Source>,
            _: Arc<AtomicBool>,
        ) -> Result<Stream, String> {
            let remaining = self.failures.load(Ordering::Acquire);
            if remaining > 0
                && self
                    .failures
                    .compare_exchange(
                        remaining,
                        remaining - 1,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
            {
                return Err("temporarily unavailable".into());
            }
            self.opened.send(std::thread::current().id()).unwrap();
            *self.callback.borrow_mut() = Some(callback);
            Ok(Stream {
                callback: self.callback.clone(),
                closed: self.closed.clone(),
            })
        }
        fn availability(&mut self, available: bool) {
            let _ = self.statuses.send(available);
        }
    }
    fn spec(name: &str, rate: u32) -> DeviceSpec {
        DeviceSpec {
            name: name.into(),
            params: OutputParams {
                sample_rate: rate,
                channels: 2,
            },
            format: cpal::SampleFormat::F32,
        }
    }

    #[test]
    fn recovery_preserves_the_source_across_missing_devices_open_failures_and_rate_changes() {
        let device = Arc::new(Mutex::new(None));
        let frames = Arc::new(AtomicUsize::new(0));
        let paused = Arc::new(AtomicBool::new(false));
        let failures = Arc::new(AtomicUsize::new(1));
        let (opened, openings) = bounded(8);
        let (closed, closures) = bounded(8);
        let (statuses, status) = bounded(16);
        let factory_device = device.clone();
        let factory_failures = failures.clone();
        let output = OutputThread::start_with_interval(
            Source {
                frames: frames.clone(),
                paused: paused.clone(),
            },
            move || Driver {
                device: factory_device,
                failures: factory_failures,
                callback: Rc::new(RefCell::new(None)),
                opened,
                closed,
                statuses,
            },
            Duration::from_millis(10),
        )
        .unwrap();
        assert!(!status.recv_timeout(Duration::from_secs(1)).unwrap());
        assert_eq!(frames.load(Ordering::Acquire), 0);
        *device.lock().unwrap() = Some(spec("Speakers", 48000));
        let owner = openings.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_ne!(owner, std::thread::current().id());
        assert!(status.recv_timeout(Duration::from_secs(1)).unwrap());
        *device.lock().unwrap() = None;
        assert_eq!(
            closures.recv_timeout(Duration::from_secs(1)).unwrap(),
            owner
        );
        assert!(!status.recv_timeout(Duration::from_secs(1)).unwrap());
        let before = frames.load(Ordering::Acquire);
        paused.store(true, Ordering::Release);
        *device.lock().unwrap() = Some(spec("Headphones", 44100));
        assert_eq!(
            openings.recv_timeout(Duration::from_secs(1)).unwrap(),
            owner
        );
        assert!(status.recv_timeout(Duration::from_secs(1)).unwrap());
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(
            frames.load(Ordering::Acquire),
            before,
            "recovering while paused must not advance the source"
        );
        paused.store(false, Ordering::Release);
        *device.lock().unwrap() = Some(spec("New speakers", 48000));
        assert_eq!(
            closures.recv_timeout(Duration::from_secs(1)).unwrap(),
            owner
        );
        assert_eq!(
            openings.recv_timeout(Duration::from_secs(1)).unwrap(),
            owner
        );
        std::thread::sleep(Duration::from_millis(30));
        assert!(frames.load(Ordering::Acquire) > before);
        drop(output);
        assert_eq!(
            closures.recv_timeout(Duration::from_secs(1)).unwrap(),
            owner
        );
    }
}
