//! Streaming audio source — bridges async HTTP download with sync symphonia Read.
//!
//! The async downloader appends chunks to an anonymous temporary file. The sync reader
//! blocks until the requested bytes are available. Since we keep all bytes on disk,
//! seeking within the already-downloaded region works instantly. Seeking beyond
//! the downloaded region blocks until enough data arrives.

use std::io::{self, Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use symphonia::core::io::MediaSource;

/// Shared state between the async downloader and the sync reader.
struct Inner {
    file: std::fs::File,
    downloaded_len: u64,
    prefix: [u8; 4],
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
/// the `abandoned` flag is set. Subsequent `push()` calls skip the temporary file
/// accumulation — the download task should keep writing to disk (cache) only.
pub struct SharedBuffer {
    inner: Mutex<Inner>,
    condvar: Condvar,
    /// Set to `true` when the StreamingReader is dropped. `push()` skips
    /// temporary-file accumulation but the download task can continue for caching.
    abandoned: AtomicBool,
}

impl SharedBuffer {
    pub fn new(content_length: Option<u64>) -> io::Result<Arc<Self>> {
        let file = tempfile::tempfile()?;
        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                file,
                downloaded_len: 0,
                prefix: [0; 4],
                done: false,
                aborted: false,
                content_length,
            }),
            condvar: Condvar::new(),
            abandoned: AtomicBool::new(false),
        }))
    }

    /// Append a chunk of bytes (called by the async downloader).
    /// If the reader has been dropped (abandoned), skips the temporary-file
    /// accumulation to avoid wasting disk space on a skipped track.
    pub fn push(&self, chunk: &[u8]) -> io::Result<()> {
        if self.abandoned.load(Ordering::Relaxed) {
            return Ok(());
        }
        let mut inner = self.inner.lock().unwrap();
        let write = inner
            .file
            .seek(SeekFrom::End(0))
            .and_then(|_| inner.file.write_all(chunk));
        if let Err(error) = write {
            inner.aborted = true;
            inner.done = true;
            self.condvar.notify_all();
            return Err(error);
        }
        let prefix_start = inner.downloaded_len.min(4) as usize;
        let prefix_count = chunk.len().min(4 - prefix_start);
        inner.prefix[prefix_start..prefix_start + prefix_count]
            .copy_from_slice(&chunk[..prefix_count]);
        inner.downloaded_len += chunk.len() as u64;
        self.condvar.notify_all();
        Ok(())
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

    /// A required integrated measurement needs real EOF, never a prefix or Content-Length guess.
    /// The playback decoder is paused during analysis; StreamingReader seeks its independent
    /// logical position before every read, so this descriptor's shared OS offset is harmless.
    pub(in crate::audio_engine) fn completed_file(
        &self,
        current: impl Fn() -> bool,
    ) -> Result<std::fs::File, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Audio preparation unavailable".to_string())?;
        while !inner.done {
            if !current() {
                return Err("Audio preparation cancelled".into());
            }
            inner = self
                .condvar
                .wait_timeout(inner, std::time::Duration::from_millis(10))
                .map_err(|_| "Audio preparation unavailable".to_string())?
                .0;
        }
        if !current() {
            return Err("Audio preparation cancelled".into());
        }
        if inner.aborted {
            return Err("Incomplete media cannot be normalized".into());
        }
        if inner
            .content_length
            .is_some_and(|len| len != inner.downloaded_len)
        {
            return Err("Incomplete media cannot be normalized".into());
        }
        let mut file = inner
            .file
            .try_clone()
            .map_err(|_| "Audio preparation file unavailable".to_string())?;
        file.seek(SeekFrom::Start(0))
            .map_err(|_| "Audio preparation file unavailable".to_string())?;
        Ok(file)
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
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            let mut inner = self.buffer.inner.lock().unwrap();
            let available = inner.downloaded_len;

            if self.pos < available {
                let len = (available - self.pos).min(buf.len() as u64) as usize;
                inner.file.seek(SeekFrom::Start(self.pos))?;
                let n = inner.file.read(&mut buf[..len])?;
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
                .wait_while(inner, |i| i.downloaded_len <= self.pos && !i.done)
                .unwrap();
        }
    }
}

impl Seek for StreamingReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let mut inner = self.buffer.inner.lock().unwrap();
        if matches!(pos, SeekFrom::End(_)) && inner.content_length.is_none() {
            // The current downloaded prefix is not the end of a chunked HTTP
            // response. Containers that need the tail must wait for real EOF.
            inner = self
                .buffer
                .condvar
                .wait_while(inner, |state| !state.done)
                .unwrap();
            if inner.aborted {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "stream download aborted",
                ));
            }
        }
        let len = inner.downloaded_len;
        let content_len = inner.content_length.unwrap_or(len);
        drop(inner);

        let new_pos = match pos {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::Current(offset) => self.pos as i128 + offset as i128,
            SeekFrom::End(offset) => content_len as i128 + offset as i128,
        };

        if new_pos < 0 || new_pos > u64::MAX as i128 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "audio byte seek is out of range",
            ));
        }

        self.pos = new_pos as u64;
        Ok(self.pos)
    }
}

impl Drop for StreamingReader {
    fn drop(&mut self) {
        // Signal that the reader is done — push() will skip file accumulation.
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
        let inner = self.buffer.inner.lock().unwrap();
        // Ogg's optional tail probe blocks first playback until the complete
        // download arrives. MP4 needs its declared extent for box indexing, so
        // defer only Ogg tail probing. Explicit byte seeks still retain the
        // announced HTTP size and can wait for the requested data.
        if inner.done {
            Some(inner.downloaded_len)
        } else if &inner.prefix == b"OggS" {
            None
        } else {
            inner.content_length
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeking_the_end_of_a_chunked_response_waits_for_the_real_tail() {
        let buf = SharedBuffer::new(None).unwrap();
        buf.push(b"prefix").unwrap();
        let source = buf.clone();
        let reader = std::thread::spawn(move || {
            let mut reader = StreamingReader::new(source);
            reader.seek(SeekFrom::End(-4)).unwrap();
            let mut tail = [0; 4];
            reader.read_exact(&mut tail).unwrap();
            (tail, reader.byte_len())
        });
        buf.push(b"tail").unwrap();
        buf.finish();
        assert_eq!(reader.join().unwrap(), (*b"tail", Some(10)));
    }

    #[test]
    fn large_downloads_are_disk_backed_and_reader_seeks_do_not_change_append_positions() {
        let buf = SharedBuffer::new(None).unwrap();
        let mut reader = StreamingReader::new(buf.clone());
        let chunk = [7u8; 65536];
        for _ in 0..128 {
            buf.push(&chunk).unwrap();
        }
        assert_eq!(
            buf.inner.lock().unwrap().file.metadata().unwrap().len(),
            8 * 1024 * 1024
        );
        reader.seek(SeekFrom::Start(100)).unwrap();
        reader.read_exact(&mut [0; 1]).unwrap();
        buf.push(b"tail").unwrap();
        buf.finish();
        reader.seek(SeekFrom::End(-4)).unwrap();
        let mut tail = [0; 4];
        reader.read_exact(&mut tail).unwrap();
        assert_eq!(&tail, b"tail");
        reader.seek(SeekFrom::Start(0)).unwrap();
        reader.read_exact(&mut tail).unwrap();
        assert_eq!(tail, [7; 4]);
        drop(reader);
        buf.push(b"abandoned").unwrap();
        assert_eq!(
            buf.inner.lock().unwrap().downloaded_len,
            8 * 1024 * 1024 + 4
        );
    }

    #[test]
    fn spool_io_failure_aborts_and_wakes_the_decoder() {
        let fixture = tempfile::NamedTempFile::new().unwrap();
        let buf = SharedBuffer::new(None).unwrap();
        // A genuinely unwritable file exercises the actual I/O error path.
        buf.inner.lock().unwrap().file = std::fs::File::open(fixture.path()).unwrap();
        let source = buf.clone();
        let reader = std::thread::spawn(move || {
            StreamingReader::new(source)
                .read(&mut [0; 1])
                .unwrap_err()
                .kind()
        });
        assert!(buf.push(b"audio").is_err());
        assert!(buf.is_aborted());
        assert_eq!(reader.join().unwrap(), io::ErrorKind::ConnectionAborted);
    }

    #[test]
    fn empty_reads_do_not_block_and_overflowing_seeks_return_errors() {
        let buf = SharedBuffer::new(Some(u64::MAX)).unwrap();
        let mut reader = StreamingReader::new(buf);
        assert_eq!(reader.read(&mut []).unwrap(), 0);
        assert_eq!(reader.seek(SeekFrom::Start(u64::MAX)).unwrap(), u64::MAX);
        assert!(reader.seek(SeekFrom::Current(1)).is_err());
        assert!(reader.seek(SeekFrom::End(1)).is_err());
    }

    #[test]
    fn hostile_content_length_does_not_reserve_the_entire_response() {
        let buf = SharedBuffer::new(Some(u64::MAX)).unwrap();
        assert_eq!(buf.inner.lock().unwrap().file.metadata().unwrap().len(), 0);
        buf.set_content_length(u64::MAX);
        assert_eq!(buf.inner.lock().unwrap().file.metadata().unwrap().len(), 0);
    }

    #[test]
    fn cancelling_a_download_wakes_a_blocked_decoder() {
        let buf = SharedBuffer::new(None).unwrap();
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
        let buf = SharedBuffer::new(None).unwrap();
        buf.push(b"hello").unwrap();
        buf.push(b" world").unwrap();
        buf.finish();

        let mut reader = StreamingReader::new(buf);
        let mut out = String::new();
        reader.read_to_string(&mut out).unwrap();
        assert_eq!(out, "hello world");
    }

    #[test]
    fn seek_within_buffer() {
        let buf = SharedBuffer::new(None).unwrap();
        buf.push(b"0123456789").unwrap();
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
        let buf = SharedBuffer::new(None).unwrap();
        let buf_clone = buf.clone();

        let writer = std::thread::spawn(move || {
            for i in 0..10 {
                std::thread::sleep(std::time::Duration::from_millis(5));
                buf_clone.push(format!("{}", i).as_bytes()).unwrap();
            }
            buf_clone.finish();
        });

        let mut reader = StreamingReader::new(buf);
        let mut out = String::new();
        reader.read_to_string(&mut out).unwrap();
        writer.join().unwrap();
        assert_eq!(out, "0123456789");
    }
    #[test]
    fn required_file_waits_for_real_eof_and_preserves_playback_reader_position() {
        let buffer = SharedBuffer::new(Some(6)).unwrap();
        buffer.push(b"abc").unwrap();
        let mut reader = StreamingReader::new(buffer.clone());
        let mut first = [0; 1];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(first, b"a"[0..1]);
        let current = AtomicBool::new(true);
        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| buffer.completed_file(|| current.load(Ordering::SeqCst)));
            buffer.push(b"def").unwrap();
            buffer.finish();
            let mut file = waiting.join().unwrap().unwrap();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"abcdef");
        });
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"bcdef");
    }
    #[test]
    fn required_file_rejects_abort_truncation_and_cancelled_wait() {
        let buffer = SharedBuffer::new(Some(6)).unwrap();
        buffer.push(b"abc").unwrap();
        buffer.finish();
        assert!(buffer.completed_file(|| true).is_err());
        let buffer = SharedBuffer::new(None).unwrap();
        buffer.abort();
        assert!(buffer.completed_file(|| true).is_err());
        let buffer = SharedBuffer::new(None).unwrap();
        assert!(buffer.completed_file(|| false).is_err());
    }
}
