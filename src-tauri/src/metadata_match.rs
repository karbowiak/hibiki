//! Conservative identity admission for public album enrichment/artwork.

fn normalized_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn normalized_album(value: &str) -> (String, Option<&'static str>) {
    let value = normalized_name(value);
    // iTunes appends these format labels to otherwise identical titles. Keep
    // named live/remix/deluxe editions and every other title distinction intact.
    if let Some(title) = value.strip_suffix(" - single") {
        (title.to_owned(), Some("single"))
    } else if let Some(title) = value.strip_suffix(" - ep") {
        (title.to_owned(), Some("ep"))
    } else {
        (value, None)
    }
}

pub(crate) fn album_matches(
    artist: &str,
    album: &str,
    returned_artist: &str,
    returned_album: &str,
) -> bool {
    let artist = normalized_name(artist);
    let (album, format) = normalized_album(album);
    let (returned_album, returned_format) = normalized_album(returned_album);
    !artist.is_empty()
        && !album.is_empty()
        && artist == normalized_name(returned_artist)
        && album == returned_album
        && (format.is_none() || returned_format.is_none() || format == returned_format)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn album_identity_requires_artist_and_title_without_erasing_named_editions() {
        assert!(album_matches(
            " Yoshiko ",
            " Bumble  Bee ",
            "YOSHIKO",
            "Bumble Bee - Single"
        ));
        assert!(album_matches("Björk", "Vespertine", "BJÖRK", "Vespertine"));
        assert!(album_matches("Artist", "Title - EP", "Artist", "Title"));
        assert!(!album_matches(
            "Artist",
            "Title - EP",
            "Artist",
            "Title - Single"
        ));
        for (artist, title) in [
            ("Various Artists", "100 Silly Sing Along Songs for Kids"),
            ("Godsmack", "Bumble Bee"),
            ("Yoshiko", "Other Album"),
            ("Yoshiko", "Bumble Bee (Live)"),
            ("Yoshiko", "Bumble Bee (Named Remix)"),
            ("Yoshiko", "Bumble Bee (Deluxe Edition)"),
        ] {
            assert!(!album_matches("Yoshiko", "Bumble Bee", artist, title));
        }
        assert!(!album_matches("", "", "", ""));
        assert!(!album_matches("Bjork", "Vespertine", "Björk", "Vespertine"));
    }
}
