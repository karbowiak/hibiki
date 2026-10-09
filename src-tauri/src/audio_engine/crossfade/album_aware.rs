//! Album-aware crossfade suppression.
//!
//! Preserve gaps only for an album deliberately started by the user. A playlist
//! may contain adjacent tracks from that album without being album playback.

/// Returns `true` if crossfade should be suppressed for this track pair.
pub fn should_suppress_crossfade(
    out_parent_key: &str,
    in_parent_key: &str,
    album_playback: bool,
    same_album_crossfade_enabled: bool,
) -> bool {
    // If same-album crossfade is enabled, never suppress
    if !album_playback || same_album_crossfade_enabled {
        return false;
    }
    // Suppress if both tracks share a non-empty parent key
    !out_parent_key.is_empty() && !in_parent_key.is_empty() && out_parent_key == in_parent_key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_album_suppresses_when_disabled() {
        assert!(should_suppress_crossfade(
            "/album/123",
            "/album/123",
            true,
            false
        ));
    }

    #[test]
    fn same_album_allows_when_enabled() {
        assert!(!should_suppress_crossfade(
            "/album/123",
            "/album/123",
            true,
            true
        ));
    }

    #[test]
    fn different_albums_never_suppress() {
        assert!(!should_suppress_crossfade(
            "/album/123",
            "/album/456",
            true,
            false
        ));
        assert!(!should_suppress_crossfade(
            "/album/123",
            "/album/456",
            true,
            true
        ));
    }

    #[test]
    fn empty_keys_never_suppress() {
        assert!(!should_suppress_crossfade("", "", true, false));
        assert!(!should_suppress_crossfade("/album/123", "", true, false));
        assert!(!should_suppress_crossfade("", "/album/123", true, false));
    }
}
