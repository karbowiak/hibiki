//! Streaming audio source — bridges async HTTP download with sync symphonia Read.
//!
//! The async downloader appends chunks to a shared buffer. The sync reader
//! blocks until the requested bytes are available. Since we keep all bytes,
//! seeking within the already-downloaded region works instantly. Seeking beyond
//! the downloaded region blocks until enough data arrives.

use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use symphonia::core::io::MediaSource;

/// Shared state between the async downloader and the sync reader.
struct Inner {
    data: Vec<u8>,
    done: bool,
    /// True when the download was aborted due to an error (not a clean finish).
    /// The reader returns `ConnectionAborted` instead of normal EOF so the
    /// decoder can distinguish truncated streams from complete ones.
    aborted: bool,
    /// Total content length from the HTTP response (if known).
    content_length: Option<u64>,
}

/// Thread-safe shared buffer. The downloader writes to it, the decoder reads from it.
///
/// When the reader side (StreamingReader) is dropped (e.g. track skipped),
/// the `abandoned` flag is set. Subsequent `push()` calls skip the in-memory
/// accumulation — the download task should keep writing to disk (cache) only.
pub struct SharedBuffer {
    inner: Mutex<Inner>,
    condvar: Condvar,
    /// Set to `true` when the StreamingReader is dropped. `push()` skips
    /// in-memory accumulation but the download task can continue for caching.
    abandoned: AtomicBool,
}

impl SharedBuffer {
    pub fn new(content_length: Option<u64>) -> Arc<Self> {
        let capacity = content_length.unwrap_or(64 * 1024).min(1024 * 1024) as usize;
        Arc::new(Self {
            inner: Mutex::new(Inner {
                data: Vec::with_capacity(capacity),
                done: false,
                aborted: false,
                content_length,
            }),
            condvar: Condvar::new(),
            abandoned: AtomicBool::new(false),
        })
    }

    /// Append a chunk of bytes (called by the async downloader).
    /// If the reader has been dropped (abandoned), skips the in-memory
    /// accumulation to avoid wasting memory on a skipped track.
    pub fn push(&self, chunk: &[u8]) {
        if self.abandoned.load(Ordering::Relaxed) {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        inner.data.extend_from_slice(chunk);
        self.condvar.notify_all();
    }

    /// Signal that the download is complete.
    pub fn finish(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.done = true;
        self.condvar.notify_all();
    }

    /// Signal a download error. The reader will return `ConnectionAborted`
    /// instead of normal EOF so the decoder can detect the truncation.
    pub fn abort(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.aborted = true;
        inner.done = true;
        self.condvar.notify_all();
    }

    pub fn is_aborted(&self) -> bool {
        self.inner.lock().unwrap().aborted
    }

    /// Set the content length once known (from HTTP Content-Length header).
    pub fn set_content_length(&self, len: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.content_length = Some(len);
        // Content-Length is untrusted and can describe multi-hour recordings.
        // Grow as data actually arrives instead of reserving the whole response.
    }
}

/// Sync reader that blocks until data is available in the shared buffer.
/// Implements `Read + Seek + MediaSource` for symphonia.
pub struct StreamingReader {
    buffer: Arc<SharedBuffer>,
    pos: u64,
}

impl StreamingReader {
    pub fn buffer(&self) -> Arc<SharedBuffer> {
        self.buffer.clone()
    }

    pub fn new(buffer: Arc<SharedBuffer>) -> Self {
        Self { buffer, pos: 0 }
    }
}

impl Read for StreamingReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let inner = self.buffer.inner.lock().unwrap();
            let available = inner.data.len() as u64;

            if self.pos < available {
                // Data available — copy what we can
                let start = self.pos as usize;
                let end = (start + buf.len()).min(inner.data.len());
                let n = end - start;
                buf[..n].copy_from_slice(&inner.data[start..end]);
                drop(inner);
                self.pos += n as u64;
                return Ok(n);
            }

            if inner.done {
                if inner.aborted {
                    // Download was aborted — signal distinct error so the
                    // decoder can tell this apart from a normal end-of-file.
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        "stream download aborted",
                    ));
                }
                // No more data coming — normal EOF
                return Ok(0);
            }

            // Wait for more data
            let _inner = self
                .buffer
                .condvar
                .wait_while(inner, |i| (i.data.len() as u64) <= self.pos && !i.done)
                .unwrap();
        }
    }
}

impl Seek for StreamingReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let inner = self.buffer.inner.lock().unwrap();
        let len = inner.data.len() as u64;
        let content_len = inner.content_length.unwrap_or(len);
        drop(inner);

        let new_pos = match pos {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::Current(offset) => self.pos as i64 + offset,
            SeekFrom::End(offset) => content_len as i64 + offset,
        };

        if new_pos < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek to negative position",
            ));
        }

        self.pos = new_pos as u64;
        Ok(self.pos)
    }
}

impl Drop for StreamingReader {
    fn drop(&mut self) {
        // Signal that the reader is done — push() will skip memory accumulation.
        // The download task can continue for caching purposes.
        self.buffer.abandoned.store(true, Ordering::Relaxed);
        // Wake any blocked push() or finish() waiting on the condvar
        self.buffer.condvar.notify_all();
    }
}

impl MediaSource for StreamingReader {
    fn is_seekable(&self) -> bool {
        // We can seek within the buffered region. Symphonia uses this for
        // format probing and container seeking.
        true
    }

    fn byte_len(&self) -> Option<u64> {
        self.buffer.inner.lock().unwrap().content_length
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostile_content_length_does_not_reserve_the_entire_response() {
        let buf = SharedBuffer::new(Some(u64::MAX));
        assert!(buf.inner.lock().unwrap().data.capacity() <= 1024 * 1024);
        buf.set_content_length(u64::MAX);
        assert!(buf.inner.lock().unwrap().data.capacity() <= 1024 * 1024);
    }

    #[test]
    fn cancelling_a_download_wakes_a_blocked_decoder() {
        let buf = SharedBuffer::new(None);
        let source = buf.clone();
        let reader = std::thread::spawn(move || {
            StreamingReader::new(source)
                .read(&mut [0; 1])
                .unwrap_err()
                .kind()
        });
        buf.abort();
        assert_eq!(reader.join().unwrap(), io::ErrorKind::ConnectionAborted);
    }

    #[test]
    fn basic_write_read() {
        let buf = SharedBuffer::new(None);
        buf.push(b"hello");
        buf.push(b" world");
        buf.finish();

        let mut reader = StreamingReader::new(buf);
        let mut out = String::new();
        reader.read_to_string(&mut out).unwrap();
        assert_eq!(out, "hello world");
    }

    #[test]
    fn seek_within_buffer() {
        let buf = SharedBuffer::new(None);
        buf.push(b"0123456789");
        buf.finish();

        let mut reader = StreamingReader::new(buf);
        let mut out = [0u8; 3];

        reader.seek(SeekFrom::Start(5)).unwrap();
        reader.read_exact(&mut out).unwrap();
        assert_eq!(&out, b"567");

        reader.seek(SeekFrom::Start(0)).unwrap();
        reader.read_exact(&mut out).unwrap();
        assert_eq!(&out, b"012");
    }

    #[test]
    fn concurrent_write_read() {
        let buf = SharedBuffer::new(None);
        let buf_clone = buf.clone();

        let writer = std::thread::spawn(move || {
            for i in 0..10 {
                std::thread::sleep(std::time::Duration::from_millis(5));
                buf_clone.push(format!("{}", i).as_bytes());
            }
            buf_clone.finish();
        });

        let mut reader = StreamingReader::new(buf);
        let mut out = String::new();
        reader.read_to_string(&mut out).unwrap();
        writer.join().unwrap();
        assert_eq!(out, "0123456789");
    }
}
