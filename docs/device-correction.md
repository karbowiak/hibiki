# Device correction

Open the equalizer from the playbar. **Tone on/off** controls the ordinary ten
bands; **Device correction → Enabled** controls the separate correction filters.
Correction runs before tone, followed by the common gain, limiter and volume path
used for Plex, YTM and other native playback sources.

Choose **Find or import** to search AutoEq by manufacturer/model, including pads,
ANC and measurement variants. The exact catalogue label, measurement source and
rig are retained. An unspecified target is shown as unspecified. Search keeps at
most 50 results in the renderer; refine the query to see a particular variant.
The public catalogue is loaded only after a search, cached natively for a day,
and refreshed in the background when stale. Downloads use the selected Git commit,
not a moving branch URL. A changed catalogue requires a new selection.

Downloaded profiles retain their original text, pinned source URL/revision and
MIT licence notice. Editing creates a local text override. Catalogue updates
never replace saved originals or edits. Saved profiles and output bindings work
offline; a custom speaker/headphone profile can also be pasted or imported as a
text file without accessing AutoEq. Catalogue coverage is not universal.

**Preview** temporarily applies the draft. **Cancel**, closing the panel or an
output change restores the existing selection without storing the draft.
**Apply** saves the correction in the local library and selects it. **Reset local
edits** restores its original text in the editor; apply to keep that change.
**Remove correction** also clears references to it from output bindings.

Use **Save to output** to retain tone and the selected correction together.
Existing bindings retain their current edits when switching outputs; applying a
library correction alone does not create a new automatic binding.
Automatic recall is available for stable output IDs, including startup and
reconnect. Turn it off to recall manually. Output IDs are separate from display
names; renamed devices keep their identity, while identically named devices do
not share a binding. An older name-based tone preset migrates only for an
unambiguous matching output, and its original data is retained. **Other saved
settings** also exposes those older tone presets for manual use.

System-route aliases or unstable device IDs use manual recall. A USB DAC cannot
identify which passive headphones are plugged into it: select the corresponding
saved correction when changing headphones. **Forget output** removes the binding
and bypasses its correction; the correction remains in the library.

Supported text uses one `Preamp` line and 1–20 `Filter` lines with ON/OFF,
PK/LSC/HSC, Fc, Gain and Q. Limits are 10–24,000 Hz, ±30 dB/filter, Q 0.1–30,
and preamp −60–+12 dB, with a 64 KB file limit. Unsupported commands/types,
duplicates and non-finite values are rejected. Active filters at or above the
mixer's Nyquist frequency are rejected rather than approximated.

The native engine prepares coefficients outside the audio callback and checks
the active stream incarnation again when adopting a complete scene. Ordinary
playback commands use a separate small channel. Changes crossfade over 25 ms
during playback without changing the track or playback position. Output changes
bypass the previous output's complete scene before rendering on the replacement.
The fixed mixer clock is independent of physical device rates; the existing
output resampler handles physical rate changes.
The retained renderer is allocated once outside the callback. Stream recovery
transfers that allocation by pointer and preserves the DSP/playback state.

The original correction preamp remains effective. Combined correction/tone
response determines any extra attenuation; automatic gain does not restore the
profile's attenuation or apply it twice. A requested manual tone gain is retained
separately from additional safety attenuation. Normalization remains independent.

Sources: [AutoEq](https://github.com/jaakkopasanen/AutoEq),
[catalogue](https://github.com/jaakkopasanen/AutoEq/blob/master/results/INDEX.md),
[licence](https://github.com/jaakkopasanen/AutoEq/blob/master/LICENSE).
