//! Validate artwork before caching or serving it. Decode work stays off async
//! workers and has its own admission bound, independent of network requests.

use image::{AnimationDecoder, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use once_cell::sync::Lazy;
use std::io::{Cursor, Write};
use std::sync::Arc;
use tokio::sync::Semaphore;

const MAX_SIDE: u32 = 8192;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_DECODED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ANIMATION_PIXELS: u64 = 128 * 1024 * 1024;
const MAX_FRAMES: usize = 256;
static DECODERS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(2)));

fn limits() -> Limits {
    // Decoder allocation accounting is best effort. Header/output/frame bounds
    // below enforce the dimensions and work limits ourselves for every codec.
    let mut limits = Limits::default();
    limits.max_alloc = Some(96 * 1024 * 1024);
    limits
}

fn dimensions(width: u32, height: u32) -> Option<u64> {
    let pixels = u64::from(width).checked_mul(u64::from(height))?;
    (width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE && pixels <= MAX_PIXELS)
        .then_some(pixels)
}

fn bounded_decoder<D: ImageDecoder>(mut decoder: D) -> Option<D> {
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    if decoder.total_bytes() > MAX_DECODED_BYTES {
        return None;
    }
    decoder.set_limits(limits()).ok()?;
    Some(decoder)
}

fn static_image(decoder: impl ImageDecoder) -> Option<()> {
    let decoder = bounded_decoder(decoder)?;
    let length = usize::try_from(decoder.total_bytes()).ok()?;
    let mut pixels = Vec::new();
    pixels.try_reserve_exact(length).ok()?;
    pixels.resize(length, 0);
    decoder.read_image(&mut pixels).ok()
}

fn animation(frames: image::Frames<'_>) -> Option<()> {
    let mut count = 0_usize;
    let mut total = 0_u64;
    for frame in frames {
        let frame = frame.ok()?;
        count += 1;
        let (width, height) = frame.buffer().dimensions();
        total = total.checked_add(dimensions(width, height)?)?;
        if count > MAX_FRAMES
            || total > MAX_ANIMATION_PIXELS
            || frame.buffer().as_raw().len() as u64 > MAX_DECODED_BYTES
        {
            return None;
        }
    }
    (count > 0).then_some(())
}

fn icon(bytes: &[u8]) -> Option<image::DynamicImage> {
    // The image crate's ICO constructor opens embedded PNGs without allocation
    // limits. Select its preferred entry ourselves before constructing a decoder.
    let count = usize::from(u16::from_le_bytes(bytes.get(4..6)?.try_into().ok()?));
    if count == 0 {
        return None;
    }
    let end = 6_usize.checked_add(count.checked_mul(16)?)?;
    let entries = bytes.get(6..end)?;
    let mut best = None;
    for entry in std::iter::once(entries.get(entries.len().checked_sub(16)?..)?)
        .chain(entries[..entries.len() - 16].chunks_exact(16))
    {
        let width = if entry[0] == 0 {
            256
        } else {
            u32::from(entry[0])
        };
        let height = if entry[1] == 0 {
            256
        } else {
            u32::from(entry[1])
        };
        let bits = u16::from_le_bytes(entry[6..8].try_into().ok()?);
        let score = (bits, width * height);
        if best
            .as_ref()
            .is_none_or(|(previous, _, _, _)| score > *previous)
        {
            best = Some((score, entry, width, height));
        }
    }
    let (_, entry, width, height) = best?;
    let length = usize::try_from(u32::from_le_bytes(entry[8..12].try_into().ok()?)).ok()?;
    let offset = usize::try_from(u32::from_le_bytes(entry[12..16].try_into().ok()?)).ok()?;
    if offset < end || length < 8 {
        return None;
    }
    let payload = bytes.get(offset..offset.checked_add(length)?)?;
    if payload.starts_with(b"\x89PNG\r\n\x1a\n") {
        let decoder = bounded_decoder(
            image::codecs::png::PngDecoder::with_limits(Cursor::new(payload), limits()).ok()?,
        )?;
        let (actual_width, actual_height) = decoder.dimensions();
        if actual_width.min(256) != width || actual_height.min(256) != height {
            return None;
        }
        image::DynamicImage::from_decoder(decoder).ok()
    } else {
        // Decode only the selected bounded DIB. The library must not select a
        // different entry or read beyond this entry's declared byte range.
        let mut selected = bytes.get(..6)?.to_vec();
        selected[4..6].copy_from_slice(&1_u16.to_le_bytes());
        selected.extend_from_slice(entry);
        selected[18..22].copy_from_slice(&22_u32.to_le_bytes());
        selected.extend_from_slice(payload);
        let decoder =
            bounded_decoder(image::codecs::ico::IcoDecoder::new(Cursor::new(&selected)).ok()?)?;
        image::DynamicImage::from_decoder(decoder).ok()
    }
}

fn accepted(format: ImageFormat) -> bool {
    matches!(
        format,
        ImageFormat::Jpeg
            | ImageFormat::Png
            | ImageFormat::WebP
            | ImageFormat::Gif
            | ImageFormat::Bmp
            | ImageFormat::Ico
            | ImageFormat::Pnm
    )
}

fn declared_format(value: &str) -> Option<ImageFormat> {
    match value {
        "image/apng" | "image/x-png" => Some(ImageFormat::Png),
        "image/jpg" | "image/pjpeg" => Some(ImageFormat::Jpeg),
        "image/x-ms-bmp" => Some(ImageFormat::Bmp),
        "image/x-portable-pixmap" | "image/x-portable-graymap" | "image/x-portable-bitmap" => {
            Some(ImageFormat::Pnm)
        }
        value => ImageFormat::from_mime_type(value),
    }
}

fn inspect(bytes: &[u8], declared: Option<&str>) -> Option<ImageFormat> {
    if bytes.is_empty() || bytes.len() > crate::image_fetch::MAX_IMAGE_BYTES {
        return None;
    }
    let format = image::guess_format(bytes).ok()?;
    if !accepted(format) {
        return None;
    }
    if let Some(declared) = declared {
        let declared = declared.split(';').next()?.trim().to_ascii_lowercase();
        if !matches!(
            declared.as_str(),
            "application/octet-stream" | "binary/octet-stream"
        ) && declared_format(&declared).is_none()
        {
            return None;
        }
    }
    let source = Cursor::new(bytes);
    match format {
        ImageFormat::Ico => {
            icon(bytes)?;
        }
        ImageFormat::Gif => animation(
            bounded_decoder(image::codecs::gif::GifDecoder::new(source).ok()?)?.into_frames(),
        )?,
        ImageFormat::Png => {
            let decoder = bounded_decoder(
                image::codecs::png::PngDecoder::with_limits(source, limits()).ok()?,
            )?;
            if decoder.is_apng().ok()? {
                animation(decoder.apng().ok()?.into_frames())?;
            } else {
                static_image(decoder)?;
            }
        }
        ImageFormat::WebP => {
            let decoder = bounded_decoder(image::codecs::webp::WebPDecoder::new(source).ok()?)?;
            if decoder.has_animation() {
                animation(decoder.into_frames())?;
            } else {
                static_image(decoder)?;
            }
        }
        _ => {
            let mut reader = ImageReader::with_format(source, format);
            reader.limits(limits());
            static_image(reader.into_decoder().ok()?)?;
        }
    }
    Some(format)
}

struct LimitedOutput(Vec<u8>);
impl Write for LimitedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > crate::image_fetch::MAX_IMAGE_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "artwork output exceeds byte limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn validated(bytes: Vec<u8>, declared: Option<&str>) -> Option<Vec<u8>> {
    let format = inspect(&bytes, declared)?;
    if !matches!(format, ImageFormat::Pnm | ImageFormat::Ico) {
        return Some(bytes);
    }
    // PPM needs a browser format. ICO must not retain unchecked alternate
    // entries. Preserve the validated pixels as a bounded PNG in both cases.
    let image = if format == ImageFormat::Ico {
        icon(&bytes)?
    } else {
        let decoder = bounded_decoder(
            ImageReader::with_format(Cursor::new(&bytes), format)
                .into_decoder()
                .ok()?,
        )?;
        image::DynamicImage::from_decoder(decoder).ok()?
    };
    let mut output = LimitedOutput(Vec::new());
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .ok()?;
    Some(output.0)
}

pub async fn validate(bytes: Vec<u8>, declared: Option<String>) -> Option<Vec<u8>> {
    let permit = DECODERS.clone().acquire_owned().await.ok()?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        validated(bytes, declared.as_deref())
    })
    .await
    .ok()?
}

/// Called only for validated response bytes; unsupported document formats never
/// acquire an image MIME type, even if they carry an image-looking extension.
pub fn mime(bytes: &[u8]) -> Option<&'static str> {
    let format = image::guess_format(bytes).ok()?;
    (accepted(format) && !matches!(format, ImageFormat::Pnm | ImageFormat::Ico))
        .then(|| format.to_mime_type())
}

#[cfg(test)]
pub(crate) fn test_png() -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        2,
        2,
        image::Rgba([30, 80, 120, 255]),
    ));
    let mut output = Cursor::new(Vec::new());
    image.write_to(&mut output, ImageFormat::Png).unwrap();
    output.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn icon_container(png: &[u8], alternate: Option<&[u8]>) -> Vec<u8> {
        let count = if alternate.is_some() { 2_u16 } else { 1_u16 };
        let start = 6_u32 + 16 * u32::from(count);
        let mut bytes = vec![0, 0, 1, 0];
        bytes.extend_from_slice(&count.to_le_bytes());
        for (width, bits, payload, offset) in std::iter::once((2_u8, 32_u16, png, start))
            .chain(alternate.map(|payload| (4, 24, payload, start + png.len() as u32)))
        {
            bytes.extend_from_slice(&[width, width, 0, 0]);
            bytes.extend_from_slice(&1_u16.to_le_bytes());
            bytes.extend_from_slice(&bits.to_le_bytes());
            bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&offset.to_le_bytes());
        }
        bytes.extend_from_slice(png);
        if let Some(alternate) = alternate {
            bytes.extend_from_slice(alternate);
        }
        bytes
    }

    #[test]
    fn icons_normalize_only_the_bounded_selected_pixels_and_drop_unchecked_entries() {
        let png = test_png();
        for alternate in [None, Some(b"malformed alternate icon".as_slice())] {
            let icon = icon_container(&png, alternate);
            let output = validated(icon, Some("image/vnd.microsoft.icon")).unwrap();
            assert_eq!(mime(&output), Some("image/png"));
            assert_eq!(
                image::load_from_memory(&output)
                    .unwrap()
                    .to_rgba8()
                    .get_pixel(0, 0)
                    .0,
                [30, 80, 120, 255]
            );
        }
        let mut truncated_entry = icon_container(&png, None);
        truncated_entry[14..18].copy_from_slice(&4_u32.to_le_bytes());
        assert!(validated(truncated_entry, None).is_none());
        let mut truncated_table = icon_container(&png, None);
        truncated_table[4..6].copy_from_slice(&u16::MAX.to_le_bytes());
        assert!(validated(truncated_table, None).is_none());
    }

    #[test]
    fn normalized_output_never_grows_past_the_encoded_byte_limit() {
        let mut output = LimitedOutput(vec![0; crate::image_fetch::MAX_IMAGE_BYTES - 1]);
        assert_eq!(output.write(&[1]).unwrap(), 1);
        assert!(output.write(&[2]).is_err());
        assert_eq!(output.0.len(), crate::image_fetch::MAX_IMAGE_BYTES);
    }

    #[test]
    fn supported_raster_bodies_keep_their_pixels_encoding_and_correct_mime() {
        for format in [
            ImageFormat::Jpeg,
            ImageFormat::Png,
            ImageFormat::WebP,
            ImageFormat::Gif,
            ImageFormat::Bmp,
        ] {
            let image = if format == ImageFormat::Jpeg {
                image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                    2,
                    2,
                    image::Rgb([30, 80, 120]),
                ))
            } else {
                image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                    2,
                    2,
                    image::Rgba([30, 80, 120, 255]),
                ))
            };
            let mut bytes = Cursor::new(Vec::new());
            image.write_to(&mut bytes, format).unwrap();
            let bytes = bytes.into_inner();
            assert_eq!(
                validated(bytes.clone(), Some(format.to_mime_type())),
                Some(bytes.clone()),
                "{format:?}"
            );
            assert_eq!(mime(&bytes), Some(format.to_mime_type()));
        }
    }

    #[test]
    fn document_payloads_bad_mime_and_incomplete_pixels_are_rejected() {
        for bytes in [
            b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>".as_slice(),
            b"<html>Sign in</html>",
            b"{\"error\":true}",
        ] {
            assert!(validated(bytes.to_vec(), None).is_none());
            assert!(mime(bytes).is_none());
        }
        let png = test_png();
        assert!(validated(png.clone(), Some("text/html")).is_none());
        assert!(validated(png.clone(), Some("image/jpeg")).is_some());
        assert!(validated(png[..png.len() / 2].to_vec(), None).is_none());
        assert!(validated(png.clone(), Some("image/png; charset=binary")).is_some());
        assert!(validated(png.clone(), Some("application/octet-stream")).is_some());
        assert!(validated(png, None).is_some());
    }

    #[test]
    fn oversized_dimensions_and_output_are_rejected_before_pixel_allocation() {
        struct HeaderOnly(u32, u32, image::ColorType);
        impl ImageDecoder for HeaderOnly {
            fn dimensions(&self) -> (u32, u32) {
                (self.0, self.1)
            }
            fn color_type(&self) -> image::ColorType {
                self.2
            }
            fn read_image(self, _: &mut [u8]) -> image::ImageResult<()> {
                panic!("oversized header must never be decoded");
            }
            fn read_image_boxed(self: Box<Self>, pixels: &mut [u8]) -> image::ImageResult<()> {
                (*self).read_image(pixels)
            }
        }
        for decoder in [
            HeaderOnly(MAX_SIDE + 1, 1, image::ColorType::Rgba8),
            HeaderOnly(MAX_SIDE, MAX_SIDE, image::ColorType::Rgba8),
            HeaderOnly(4096, 4096, image::ColorType::Rgba16),
            HeaderOnly(0, 2, image::ColorType::Rgb8),
        ] {
            assert!(static_image(decoder).is_none());
        }
        assert!(validated(b"P6\n999999 999999\n255\n".to_vec(), None).is_none());
    }

    #[test]
    fn animation_work_is_bounded_and_original_animation_is_preserved() {
        for count in [2, MAX_FRAMES + 1] {
            let mut encoded = Vec::new();
            {
                let mut encoder = image::codecs::gif::GifEncoder::new(&mut encoded);
                encoder
                    .encode_frames((0..count).map(|_| {
                        image::Frame::new(image::RgbaImage::from_pixel(
                            1,
                            1,
                            image::Rgba([30, 80, 120, 255]),
                        ))
                    }))
                    .unwrap();
            }
            let result = validated(encoded.clone(), Some("image/gif"));
            if count <= MAX_FRAMES {
                assert_eq!(result, Some(encoded));
            } else {
                assert!(result.is_none());
            }
        }
    }

    #[test]
    fn small_animation_frames_cannot_hide_excessive_canvas_work() {
        let mut encoded = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut encoded);
            encoder
                .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                    1024,
                    1024,
                    image::Rgba([30, 80, 120, 255]),
                )))
                .unwrap();
            encoder
                .encode_frames((0..128).map(|_| {
                    image::Frame::new(image::RgbaImage::from_pixel(
                        1,
                        1,
                        image::Rgba([30, 80, 120, 255]),
                    ))
                }))
                .unwrap();
        }
        assert!(encoded.len() < crate::image_fetch::MAX_IMAGE_BYTES);
        assert!(validated(encoded, Some("image/gif")).is_none());
    }

    #[test]
    fn plex_ppm_is_converted_to_a_browser_image_without_changing_pixels() {
        let bytes = validated(
            b"P6\n1 1\n255\n\x1e\x50\x78".to_vec(),
            Some("image/x-portable-pixmap"),
        )
        .unwrap();
        assert_eq!(mime(&bytes), Some("image/png"));
        assert_eq!(
            image::load_from_memory(&bytes)
                .unwrap()
                .to_rgb8()
                .get_pixel(0, 0)
                .0,
            [30, 80, 120]
        );
    }
}
