//! FDK AAC decoding using the native AudioSpecificConfig and speaker metadata.

use fdk_aac_sys as sys;
use std::ptr::NonNull;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use symphonia::core::audio::{
    AsGenericAudioBufferRef, Audio, AudioBuffer, AudioMut, AudioSpec as SignalSpec,
    GenericAudioBufferRef as AudioBufferRef, Position as Channels,
};
use symphonia::core::codecs::CodecInfo;
use symphonia::core::codecs::audio::FinalizeResult;
use symphonia::core::codecs::audio::{
    AudioCodecParameters as CodecParameters, AudioDecoder as Decoder,
    AudioDecoderOptions as DecoderOptions, well_known::CODEC_ID_AAC,
};
use symphonia::core::codecs::registry::{RegisterableAudioDecoder, SupportedAudioCodec};
use symphonia::core::errors::{Error, Result};
#[cfg(test)]
use symphonia::core::packet::Packet;
use symphonia::core::packet::PacketRef;
use symphonia::core::units::{Duration, Timestamp};

const MAX_CHANNELS: usize = 8;
const MAX_FRAMES: usize = 4096;
const MAX_CONFIG_BYTES: usize = 65536;

struct Handle(NonNull<sys::AAC_DECODER_INSTANCE>);

impl Handle {
    fn open(config: &[u8]) -> Result<Self> {
        if config.is_empty() || config.len() > MAX_CONFIG_BYTES {
            return Err(Error::DecodeError("aac: invalid audio configuration size"));
        }
        // SAFETY: one raw AAC layer; the native allocation is checked for null
        // and immediately owned by a handle with a matching destructor.
        let raw = unsafe { sys::aacDecoder_Open(sys::TRANSPORT_TYPE_TT_MP4_RAW, 1) };
        let handle = Self(NonNull::new(raw).ok_or(Error::DecodeError("aac: allocation failed"))?);
        let mut owned = config.to_vec();
        let mut pointer = owned.as_mut_ptr();
        let length = owned.len() as u32;
        // SAFETY: the configuration buffer and its single-layer pointer/length
        // are live for this call. FDK copies the configuration internally.
        let status = unsafe { sys::aacDecoder_ConfigRaw(handle.0.as_ptr(), &mut pointer, &length) };
        if status != sys::AAC_DECODER_ERROR_AAC_DEC_OK {
            return Err(Error::Unsupported(
                "aac: unsupported or invalid audio configuration",
            ));
        }
        // SAFETY: this live decoder parameter takes an integer mapping selector.
        let status = unsafe {
            sys::aacDecoder_SetParam(
                handle.0.as_ptr(),
                sys::AACDEC_PARAM_AAC_PCM_OUTPUT_CHANNEL_MAPPING,
                1,
            )
        };
        if status != sys::AAC_DECODER_ERROR_AAC_DEC_OK {
            return Err(Error::DecodeError(
                "aac: output mapping configuration failed",
            ));
        }
        Ok(handle)
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: this uniquely owned non-null handle is closed exactly once.
        unsafe { sys::aacDecoder_Close(self.0.as_ptr()) }
    }
}

fn configuration(params: &CodecParameters) -> Result<Vec<u8>> {
    if let Some(data) = &params.extra_data {
        if data.len() < 2 || data.len() > MAX_CONFIG_BYTES {
            return Err(Error::DecodeError("aac: invalid audio configuration size"));
        }
        return Ok(data.to_vec());
    }
    Err(Error::Unsupported("aac: missing audio configuration"))
}

fn speaker_mapping(types: &[u32], indices: &[u8]) -> Result<(Channels, Vec<usize>)> {
    if types.len() != indices.len() || types.is_empty() || types.len() > MAX_CHANNELS {
        return Err(Error::Unsupported("aac: unsupported speaker count"));
    }
    let mut speakers = Vec::with_capacity(types.len());
    let mut layout = Channels::empty();
    for (wire, (&kind, &index)) in types.iter().zip(indices).enumerate() {
        let count = types.iter().filter(|&&value| value == kind).count();
        if usize::from(index) >= count {
            return Err(Error::DecodeError("aac: invalid speaker index"));
        }
        let odd = count % 2 == 1;
        let position = match kind {
            sys::AUDIO_CHANNEL_TYPE_ACT_FRONT => {
                let order: &[Channels] = if odd {
                    &[
                        Channels::FRONT_CENTER,
                        Channels::FRONT_LEFT,
                        Channels::FRONT_RIGHT,
                        Channels::FRONT_LEFT_CENTER,
                        Channels::FRONT_RIGHT_CENTER,
                    ]
                } else {
                    &[
                        Channels::FRONT_LEFT,
                        Channels::FRONT_RIGHT,
                        Channels::FRONT_LEFT_CENTER,
                        Channels::FRONT_RIGHT_CENTER,
                    ]
                };
                order.get(usize::from(index)).copied()
            }
            sys::AUDIO_CHANNEL_TYPE_ACT_BACK => {
                let order: &[Channels] = if odd {
                    &[
                        Channels::REAR_CENTER,
                        Channels::REAR_LEFT,
                        Channels::REAR_RIGHT,
                    ]
                } else {
                    &[Channels::REAR_LEFT, Channels::REAR_RIGHT]
                };
                order.get(usize::from(index)).copied()
            }
            sys::AUDIO_CHANNEL_TYPE_ACT_SIDE if count == 2 => {
                [Channels::SIDE_LEFT, Channels::SIDE_RIGHT]
                    .get(usize::from(index))
                    .copied()
            }
            sys::AUDIO_CHANNEL_TYPE_ACT_LFE => [Channels::LFE1, Channels::LFE2]
                .get(usize::from(index))
                .copied(),
            sys::AUDIO_CHANNEL_TYPE_ACT_FRONT_TOP => {
                let order: &[Channels] = if odd {
                    &[
                        Channels::TOP_FRONT_CENTER,
                        Channels::TOP_FRONT_LEFT,
                        Channels::TOP_FRONT_RIGHT,
                    ]
                } else {
                    &[Channels::TOP_FRONT_LEFT, Channels::TOP_FRONT_RIGHT]
                };
                order.get(usize::from(index)).copied()
            }
            sys::AUDIO_CHANNEL_TYPE_ACT_BACK_TOP => {
                let order: &[Channels] = if odd {
                    &[
                        Channels::TOP_REAR_CENTER,
                        Channels::TOP_REAR_LEFT,
                        Channels::TOP_REAR_RIGHT,
                    ]
                } else {
                    &[Channels::TOP_REAR_LEFT, Channels::TOP_REAR_RIGHT]
                };
                order.get(usize::from(index)).copied()
            }
            _ => None,
        }
        .ok_or(Error::Unsupported("aac: unsupported speaker layout"))?;
        if layout.contains(position) {
            return Err(Error::DecodeError("aac: duplicate speaker position"));
        }
        layout |= position;
        speakers.push((position, wire));
    }
    speakers.sort_by_key(|(position, _)| position.bits());
    Ok((layout, speakers.into_iter().map(|(_, wire)| wire).collect()))
}

pub(super) struct AacDecoder {
    handle: Handle,
    params: CodecParameters,
    config: Vec<u8>,
    pcm: Vec<i16>,
    buf: AudioBuffer<i16>,
    usable: bool,
    initialization: Vec<Box<[u8]>>,
    initialization_end: i64,
    just_reset: bool,
    seek_from_start: Arc<AtomicBool>,
}

// The native handle is uniquely owned and never exposed. Mutation is exclusive
// during initialization/reset/decode; shared access reads only Rust buffers.
unsafe impl Send for AacDecoder {}
unsafe impl Sync for AacDecoder {}

impl AacDecoder {
    pub(super) fn try_new(params: &CodecParameters, _options: &DecoderOptions) -> Result<Self> {
        if params.codec != CODEC_ID_AAC {
            return Err(Error::Unsupported("aac: codec mismatch"));
        }
        let config = configuration(params)?;
        let handle = Handle::open(&config)?;
        let rate = params.sample_rate.unwrap_or(48000);
        let layout = params
            .channels
            .clone()
            .unwrap_or_else(|| (Channels::FRONT_LEFT | Channels::FRONT_RIGHT).into());
        if !(7350..=768000).contains(&rate) || !(1..=MAX_CHANNELS).contains(&layout.count()) {
            return Err(Error::Unsupported("aac: invalid declared audio format"));
        }
        Ok(Self {
            handle,
            config,
            params: params.clone(),
            pcm: vec![0; MAX_FRAMES * MAX_CHANNELS],
            buf: AudioBuffer::new(SignalSpec::new(rate, layout), MAX_FRAMES),
            usable: true,
            initialization: Vec::new(),
            initialization_end: 0,
            just_reset: false,
            seek_from_start: Arc::new(AtomicBool::new(false)),
        })
    }
}
const CODEC_INFO: CodecInfo = CodecInfo {
    short_name: "aac",
    long_name: "FDK AAC",
    profiles: &[],
};
impl RegisterableAudioDecoder for AacDecoder {
    fn try_registry_new(
        params: &CodecParameters,
        options: &DecoderOptions,
    ) -> Result<Box<dyn Decoder>> {
        Ok(Box::new(Self::try_new(params, options)?))
    }
    fn supported_codecs() -> &'static [SupportedAudioCodec] {
        &[SupportedAudioCodec {
            id: CODEC_ID_AAC,
            info: CODEC_INFO,
        }]
    }
}
impl Decoder for AacDecoder {
    fn codec_info(&self) -> &CodecInfo {
        &CODEC_INFO
    }
    fn reset(&mut self) {
        self.buf.clear();
        self.just_reset = false;
        self.usable = false;
        if let Ok(handle) = Handle::open(&self.config) {
            self.handle = handle;
            self.usable = true;
            // Relearn the initial in-band SBR/PS header on a fresh decoder.
            // CLRHIST also retires PS header state. Replay bounded initial access
            // units instead of retaining history from the old playback position.
            for initialization in self.initialization.clone() {
                let packet = PacketRef::new(0, Timestamp::MAX, Duration::ZERO, &initialization);
                if self.decode_packet(&packet).is_err() {
                    self.usable = false;
                    break;
                }
            }
        }
        self.buf.clear();
        self.just_reset = true;
    }

    fn codec_params(&self) -> &CodecParameters {
        &self.params
    }

    fn decode_ref(&mut self, packet: &PacketRef<'_>) -> Result<AudioBufferRef<'_>> {
        self.buf.clear();
        if let Err(error) = self.decode_packet(packet) {
            // Partial or corrupt access units must not become transport input
            // for the next packet. Retire pending bytes and filterbank history.
            self.reset();
            return Err(error);
        }
        Ok(self.buf.as_generic_audio_buffer_ref())
    }

    fn finalize(&mut self) -> FinalizeResult {
        FinalizeResult::default()
    }
    fn last_decoded(&self) -> AudioBufferRef<'_> {
        self.buf.as_generic_audio_buffer_ref()
    }
}

impl AacDecoder {
    pub(super) fn seek_policy(&self) -> Arc<AtomicBool> {
        self.seek_from_start.clone()
    }

    fn decode_packet(&mut self, packet: &PacketRef<'_>) -> Result<()> {
        self.buf.clear();
        if std::mem::take(&mut self.just_reset) && packet.pts.get() == 0 {
            // At the beginning preserve the original decoder delay rather than
            // the extra packet used only to initialize a mid-file seek.
            self.handle = Handle::open(&self.config)?;
            self.usable = true;
        }
        if !self.usable {
            return Err(Error::DecodeError("aac: decoder reset failed"));
        }
        let data = packet.data;
        if data.is_empty() {
            return Err(Error::DecodeError("aac: empty audio packet"));
        }
        let length = u32::try_from(data.len())
            .map_err(|_| Error::DecodeError("aac: oversized audio packet"))?;
        let mut pointer = data.as_ptr() as *mut u8;
        let mut remaining = length;
        // SAFETY: the one-layer input pointer references `length` readable bytes;
        // FDK updates the valid-byte counter while copying input internally.
        let status = unsafe {
            sys::aacDecoder_Fill(
                self.handle.0.as_ptr(),
                &mut pointer,
                &length,
                &mut remaining,
            )
        };
        if status != sys::AAC_DECODER_ERROR_AAC_DEC_OK || remaining != 0 {
            return Err(Error::DecodeError("aac: input packet was not consumed"));
        }
        // SAFETY: output is initialized and sized for the supported maximum
        // channel/frame product. FDK checks capacity before writing PCM.
        let status = unsafe {
            sys::aacDecoder_DecodeFrame(
                self.handle.0.as_ptr(),
                self.pcm.as_mut_ptr(),
                self.pcm.len() as i32,
                0,
            )
        };
        if status != sys::AAC_DECODER_ERROR_AAC_DEC_OK {
            return Err(Error::DecodeError("aac: invalid audio packet"));
        }
        // SAFETY: a live decoder owns the stream-info record until its next mutation.
        let info = unsafe { sys::aacDecoder_GetStreamInfo(self.handle.0.as_ptr()).as_ref() }
            .ok_or(Error::DecodeError("aac: missing stream information"))?;
        if !(7350..=768000).contains(&info.sampleRate)
            || !(1..=MAX_FRAMES as i32).contains(&info.frameSize)
            || !(1..=MAX_CHANNELS as i32).contains(&info.numChannels)
            || info.pChannelType.is_null()
            || info.pChannelIndices.is_null()
        {
            return Err(Error::Unsupported("aac: unsupported decoded format"));
        }
        let channels = info.numChannels as usize;
        // PS/MPS expands a core with stateful, delta-coded spatial side
        // information. A fixed preroll cannot recover all earlier parameters.
        if info.aacNumChannels > 0 && (info.aacNumChannels as usize) < channels {
            self.seek_from_start.store(true, Ordering::Release);
        }
        let frames = info.frameSize as usize;
        // SAFETY: FDK supplies arrays with exactly numChannels elements, validated
        // to 1..=8 above, and no native mutation occurs while reading these slices.
        let types = unsafe { std::slice::from_raw_parts(info.pChannelType, channels) };
        let indices = unsafe { std::slice::from_raw_parts(info.pChannelIndices, channels) };
        let (layout, mapping) = speaker_mapping(types, indices)?;
        let spec = SignalSpec::new(info.sampleRate as u32, layout.into());
        if *self.buf.spec() != spec {
            self.buf = AudioBuffer::new(spec, MAX_FRAMES);
        }
        self.buf.render_uninit(Some(frames));
        for (channel, &wire) in mapping.iter().enumerate() {
            for (frame, sample) in self
                .buf
                .plane_mut(channel)
                .expect("validated channel")
                .iter_mut()
                .enumerate()
            {
                *sample = self.pcm[frame * channels + wire];
            }
        }
        self.buf.trim(
            packet.trim_start.get() as usize,
            packet.trim_end.get() as usize,
        );
        if self.initialization.len() < 4
            && packet.pts.get() == self.initialization_end
            && data.len() <= 32768
        {
            self.initialization.push(data.into());
            self.initialization_end = packet.pts.get().saturating_add(packet.dur.get() as i64);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_access_unit() -> (CodecParameters, Packet) {
        let data = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/he-aac-v2-stereo.m4a"
        ));
        let mut setup = super::super::decode::probe_audio(data.to_vec()).unwrap();
        (
            setup.decoder.codec_params().clone(),
            setup.format.next_packet().unwrap().unwrap(),
        )
    }

    fn pcm(decoder: &mut AacDecoder, packet: &Packet) -> Vec<i16> {
        let decoded = decoder.decode(packet).unwrap();
        let mut output = Vec::new();
        decoded.copy_to_vec_interleaved(&mut output);
        output
    }

    #[test]
    fn reset_and_bad_access_units_clear_pcm_and_pending_decoder_input() {
        let (params, packet) = first_access_unit();
        let mut decoder = AacDecoder::try_new(&params, &DecoderOptions::default()).unwrap();
        let expected = pcm(&mut decoder, &packet);
        assert!(!expected.is_empty());
        pcm(&mut decoder, &packet);
        decoder.reset();
        assert_eq!(decoder.last_decoded().frames(), 0);
        assert_eq!(pcm(&mut decoder, &packet), expected);
        for invalid in [&[][..], &&packet.data[..1], &[0xff; 32769][..]] {
            let bad = Packet::new(0, Timestamp::ZERO, Duration::new(1024), invalid);
            assert!(decoder.decode(&bad).is_err());
            assert_eq!(decoder.last_decoded().frames(), 0);
            assert_eq!(pcm(&mut decoder, &packet), expected);
        }
    }

    #[test]
    fn invalid_configuration_and_declared_formats_are_rejected_without_panics() {
        let (params, _) = first_access_unit();
        for extra in [
            None,
            Some(Vec::new().into_boxed_slice()),
            Some(vec![0].into_boxed_slice()),
            Some(vec![0xff; MAX_CONFIG_BYTES + 1].into_boxed_slice()),
        ] {
            let mut invalid = params.clone();
            invalid.extra_data = extra;
            assert!(AacDecoder::try_new(&invalid, &DecoderOptions::default()).is_err());
        }
        for (rate, channels) in [
            (0, Channels::FRONT_LEFT),
            (u32::MAX, Channels::FRONT_LEFT),
            (48000, Channels::empty()),
            (48000, Channels::all()),
        ] {
            let mut invalid = params.clone();
            invalid.sample_rate = Some(rate);
            invalid.channels = Some(channels.into());
            assert!(AacDecoder::try_new(&invalid, &DecoderOptions::default()).is_err());
        }
        let mut invalid = params;
        invalid.codec = symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS;
        assert!(AacDecoder::try_new(&invalid, &DecoderOptions::default()).is_err());
    }

    #[test]
    fn channel_metadata_keeps_named_speakers_and_rejects_ambiguous_positions() {
        let f = sys::AUDIO_CHANNEL_TYPE_ACT_FRONT;
        let r = sys::AUDIO_CHANNEL_TYPE_ACT_BACK;
        let s = sys::AUDIO_CHANNEL_TYPE_ACT_SIDE;
        let l = sys::AUDIO_CHANNEL_TYPE_ACT_LFE;
        let (layout, order) =
            speaker_mapping(&[f, f, f, l, r, r, s, s], &[1, 2, 0, 0, 0, 1, 0, 1]).unwrap();
        assert_eq!(layout.iter().count(), 8);
        assert_eq!(order, [0, 1, 2, 3, 4, 5, 6, 7]);
        for (types, indices) in [
            (&[f, f][..], &[0, 0][..]),
            (&[f][..], &[1][..]),
            (&[0][..], &[0][..]),
            (&[f][..], &[][..]),
            (&[][..], &[][..]),
            (&[f; 9][..], &[0; 9][..]),
        ] {
            assert!(speaker_mapping(types, indices).is_err());
        }
    }
}
