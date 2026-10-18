//! Read-only music discovery. Website credentials never leave the native client.
use super::*;
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistCredit {
    pub name: String,
    pub id: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub artist_credits: Vec<ArtistCredit>,
    pub description: String,
    pub thumbnail: Option<String>,
    pub duration: Option<String>,
    pub album: Option<String>,
    pub year: Option<i32>,
    pub release_date: Option<String>,
    pub track_count: Option<u32>,
    pub album_id: Option<String>,
    pub artist_id: Option<String>,
    pub track_number: Option<u32>,
    pub explicit: Option<bool>,
    pub view_count: Option<u64>,
    #[serde(default)]
    pub liked: Option<bool>,
    #[serde(default)]
    pub playlist_item_id: Option<String>,
    #[serde(default)]
    pub video_type: Option<String>,
    #[serde(default)]
    pub unavailable: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub browse_id: String,
    pub params: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    id: String,
    title: String,
    category: String,
    items: Vec<Item>,
    destination: Option<Destination>,
    continuation: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePage {
    pub(super) title: String,
    pub(super) items: Vec<Item>,
    hubs: Vec<Shelf>,
    pub(super) continuation: Option<String>,
    thumbnail: Option<String>,
    pub(super) description: Option<String>,
    artist: Option<Artist>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lyrics: Option<super::lyrics::Lyrics>,
}

impl BrowsePage {
    pub(super) fn song_like_changed(&mut self, video_id: &str, liked: bool) -> bool {
        let mut changed = false;
        for item in self.items.iter_mut().chain(self.hubs.iter_mut().flat_map(|shelf| shelf.items.iter_mut())) {
            if item.kind == "song" && item.id == video_id && item.liked != Some(liked) {
                item.liked = Some(liked);
                changed = true;
            }
        }
        changed
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    id: String,
    channel_id: Option<String>,
    name: String,
    thumbnail: Option<String>,
    background: Option<String>,
    description: Option<String>,
    monthly_listeners: Option<String>,
    subscribers: Option<String>,
    songs: Option<Destination>,
    shuffle: Option<Destination>,
}

fn text(value: &Value) -> String {
    value.as_str().or_else(|| value["simpleText"].as_str()).map(str::to_owned).unwrap_or_else(||
        value["runs"].as_array().map(|runs| runs.iter().filter_map(|run| run["text"].as_str()).collect()).unwrap_or_default())
}

pub(super) fn find<'a>(value: &'a Value, key: &str, depth: usize) -> Option<&'a Value> {
    if depth > 40 { return None; }
    match value {
        Value::Object(map) => map.get(key).or_else(|| map.values().find_map(|value| find(value, key, depth + 1))),
        Value::Array(items) => items.iter().find_map(|value| find(value, key, depth + 1)),
        _ => None,
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn artwork_url(raw: &str) -> Option<String> {
    let origin = url::Url::parse("https://music.youtube.com/").ok()?;
    let url = origin.join(raw).ok()?;
    let host = url.host_str()?;
    let cdn = ["googleusercontent.com", "ggpht.com", "ytimg.com"].iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    let generated = host == "music.youtube.com" && url.path().starts_with("/image/");
    let static_cover = host == "www.gstatic.com" && url.path().starts_with("/youtube/media/ytm/");
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        && url.port_or_known_default() == Some(443) && (cdn || generated || static_cover))
        .then(|| url.to_string())
}

fn thumbnail(value: &Value) -> Option<String> {
    let images = value.pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails")
        .or_else(|| value.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"))
        .or_else(|| value.pointer("/thumbnail/thumbnails"))
        .or_else(|| find(value, "thumbnails", 0))?.as_array()?;
    images.iter().filter_map(|image| {
        let url = artwork_url(image["url"].as_str()?)?;
        let width = image["width"].as_u64().unwrap_or(0);
        let height = image["height"].as_u64().unwrap_or(0);
        let square = width > 0 && height > 0 && width.abs_diff(height) < width / 3 + 1;
        Some((square, width, url))
    }).max_by_key(|(square, width, _)| (*square, *width)).map(|(_, _, url)| url)
}

fn destination(value: &Value) -> Option<Destination> {
    let endpoint = find(value, "browseEndpoint", 0)?;
    let id = endpoint["browseId"].as_str()?;
    valid_id(id).then(|| Destination { browse_id: id.into(), params: endpoint["params"].as_str().map(str::to_owned) })
}

fn liked(value: &Value) -> Option<bool> {
    if let Some(status) = value.get("likeStatus").or_else(|| find(&value["menu"], "likeStatus", 0)).and_then(Value::as_str) {
        match status { "LIKE" => return Some(true), "INDIFFERENT" | "DISLIKE" => return Some(false), _ => {} }
    }
    // Watch queues expose the action the menu would take, rather than the
    // current status. Removing a like means the song is already liked.
    for entry in value.pointer("/menu/menuRenderer/items").and_then(Value::as_array).into_iter().flatten() {
        if let Some(toggle) = entry.get("menuServiceItemRenderer").or_else(|| entry.get("toggleMenuServiceItemRenderer")) {
            let status = toggle.pointer("/defaultServiceEndpoint/likeEndpoint/status")
                .or_else(|| toggle.pointer("/serviceEndpoint/likeEndpoint/status")).and_then(Value::as_str);
            let toggled = toggle["isToggled"].as_bool().unwrap_or(false);
            match status { Some("LIKE") => return Some(toggled), Some("INDIFFERENT") => return Some(!toggled), _ => {} }
        }
    }
    None
}

fn card(value: &Value, collection: bool, live: bool) -> Option<Item> {
    if let Some(panel) = value.get("playlistPanelVideoRenderer") {
        let id = panel["videoId"].as_str()?;
        let video_type = find(&panel["navigationEndpoint"], "musicVideoType", 0).and_then(Value::as_str);
        if !api::valid_video_id(id) || video_type.is_some_and(|kind| kind != "MUSIC_VIDEO_TYPE_ATV" && !(live && matches!(kind, "MUSIC_VIDEO_TYPE_OMV" | "MUSIC_VIDEO_TYPE_UGC"))) { return None; }
        let title = text(&panel["title"]);
        if title.is_empty() { return None; }
        let mut artist_id = None;
        let mut album = None;
        let mut album_id = None;
        let mut artists = Vec::new();
        let mut artist_credits = Vec::new();
        for byline in ["longBylineText", "shortBylineText"] {
            for run in panel[byline]["runs"].as_array().into_iter().flatten() {
                let browse = run.pointer("/navigationEndpoint/browseEndpoint/browseId").and_then(Value::as_str).unwrap_or_default();
                if browse.starts_with("UC") && valid_id(browse) {
                    if artist_id.is_none() { artist_id = Some(browse.to_owned()); }
                    let name = run["text"].as_str().unwrap_or_default().to_owned();
                    if !name.is_empty() && !artists.contains(&name) {
                        artist_credits.push(ArtistCredit { name: name.clone(), id: Some(browse.into()) });
                        artists.push(name);
                    }
                } else if browse.starts_with("MPRE") && valid_id(browse) {
                    album_id = Some(browse.to_owned());
                    album = run["text"].as_str().filter(|name| !name.is_empty()).map(str::to_owned);
                }
            }
        }
        let artist = if artists.is_empty() { text(&panel["shortBylineText"]) } else { artists.join(", ") };
        return Some(Item { id: id.into(), kind: "song".into(), title,
            description: text(&panel["longBylineText"]), artist, artist_credits, thumbnail: thumbnail(panel),
            duration: Some(text(&panel["lengthText"])).filter(|value| !value.is_empty()), album, year: None, release_date: None, track_count: None,
            album_id, artist_id, track_number: None, explicit: None, view_count: None, liked: liked(panel), playlist_item_id: None,
            video_type: video_type.map(str::to_owned), unavailable: false });
    }
    let flat = value.get("musicResponsiveListItemRenderer");
    let item = flat.or_else(|| value.get("musicTwoRowItemRenderer"))
        .or_else(|| value.get("musicCardShelfRenderer"))?;
    let title_value = if flat.is_some() {
        item.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text")?
    } else { &item["title"] };
    let title = text(title_value);
    if title.is_empty() { return None; }
    let subtitle = if flat.is_some() {
        item.pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text").unwrap_or(&Value::Null)
    } else { &item["subtitle"] };
    let runs = subtitle["runs"].as_array();
    let mut artists = Vec::new();
    let mut artist_credits = Vec::new();
    let mut album = None;
    let mut album_id = None;
    let mut artist_id = None;
    let mut year = None;
    let mut duration = item.pointer("/fixedColumns/0/musicResponsiveListItemFixedColumnRenderer/text").map(text).filter(|s| !s.is_empty());
    for run in runs.into_iter().flatten() {
        let label = run["text"].as_str().unwrap_or_default();
        let browse = run.pointer("/navigationEndpoint/browseEndpoint/browseId").and_then(Value::as_str).unwrap_or_default();
        if browse.starts_with("UC") && valid_id(browse) {
            if !label.trim().is_empty() && !artists.iter().any(|name| name == label) {
                artists.push(label.to_owned());
                artist_credits.push(ArtistCredit { name: label.into(), id: Some(browse.into()) });
            }
            if artist_id.is_none() { artist_id = Some(browse.to_owned()); }
        }
        else if browse.starts_with("MPRE") { album = Some(label.to_owned()); album_id = Some(browse.to_owned()); }
        else if label.contains(':') && label.chars().all(|c| c.is_ascii_digit() || c == ':') { duration = Some(label.into()); }
        else if let Ok(n) = label.parse::<i32>() { if (1900..=2200).contains(&n) { year = Some(n); } }
    }
    // Playlist artist runs may be plain text, with no artist browse destination.
    if artists.is_empty() && flat.is_some() {
        let subtitle = text(subtitle);
        // Search rows also include album and duration after bullet separators.
        // These are metadata, not part of an unlinked performer's name.
        let label = subtitle.split('•').next().unwrap_or_default().trim();
        if !label.is_empty() && !label.chars().all(|c| c.is_ascii_digit() || c == ':') {
            artists.push(label.to_owned());
            artist_credits.push(ArtistCredit { name: label.into(), id: None });
        }
    }
    if flat.is_some() && album.is_none() {
        let column = item.pointer("/flexColumns/2/musicResponsiveListItemFlexColumnRenderer/text");
        // Artist shelves use this column for popularity, not always a release.
        // Only an album browse run establishes release identity. Do not turn
        // "1.2M plays", a duration, or a menu destination into an album title.
        for run in column.and_then(|column| column["runs"].as_array()).into_iter().flatten() {
            let browse = run.pointer("/navigationEndpoint/browseEndpoint/browseId").and_then(Value::as_str).unwrap_or_default();
            if browse.starts_with("MPRE") && valid_id(browse) {
                album = run["text"].as_str().filter(|name| !name.trim().is_empty()).map(str::to_owned);
                album_id = album.as_ref().map(|_| browse.to_owned());
                break;
            }
        }
    }
    let endpoint = item.get("navigationEndpoint").filter(|endpoint| endpoint.get("browseEndpoint").is_some())
        .or_else(|| title_value.pointer("/runs/0/navigationEndpoint"))
        .or_else(|| item.get("navigationEndpoint")).or_else(|| item.get("onTap"));
    let browse = endpoint.and_then(|e| e.get("browseEndpoint"));
    let page_type = browse.and_then(|e| e.pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")).and_then(Value::as_str);
    let watch = item.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint")
        .or_else(|| endpoint.and_then(|e| e.get("watchEndpoint")))
        .or_else(|| item.pointer("/onTap/watchEndpoint"));
    let (kind, id) = match page_type {
        Some("MUSIC_PAGE_TYPE_ALBUM") => ("album", browse?["browseId"].as_str()?.to_owned()),
        Some("MUSIC_PAGE_TYPE_PLAYLIST") => ("playlist", browse?["browseId"].as_str()?.to_owned()),
        Some("MUSIC_PAGE_TYPE_ARTIST") if collection => ("artist", browse?["browseId"].as_str()?.to_owned()),
        Some("MUSIC_PAGE_TYPE_USER_CHANNEL") if collection && browse?["browseId"].as_str().is_some_and(|id| id.starts_with("UC") || id.starts_with("MPLAUC")) =>
            ("artist", browse?["browseId"].as_str()?.to_owned()),
        Some(_) => return None,
        None => {
            let watch_playlist = item.pointer("/navigationEndpoint/watchPlaylistEndpoint/playlistId");
            let browse_id = browse.and_then(|e| e["browseId"].as_str());
            if collection && browse_id.is_some_and(|id| id.starts_with("UC") || id.starts_with("MPLAUC")) {
                ("artist", browse?["browseId"].as_str()?.to_owned())
            } else if collection && browse_id.is_some_and(|id| id.starts_with("MPRE")) {
                ("album", browse?["browseId"].as_str()?.to_owned())
            } else if let Some(id) = watch_playlist.and_then(Value::as_str) {
                ("playlist", format!("VL{id}"))
            } else {
                let watch = watch?;
                let video_type = find(watch, "musicVideoType", 0).and_then(Value::as_str);
                // ATV is an audio track. Omit videos, Shorts, podcasts and unknown
                // home watch cards; album/playlist shelves may omit this metadata.
                if video_type != Some("MUSIC_VIDEO_TYPE_ATV") && !(collection && video_type.is_none()) && !(live && matches!(video_type, Some("MUSIC_VIDEO_TYPE_OMV" | "MUSIC_VIDEO_TYPE_UGC"))) { return None; }
                let id = watch["videoId"].as_str()?;
                if !api::valid_video_id(id) { return None; }
                ("song", id.to_owned())
            }
        }
    };
    let id = if kind == "artist" && id.starts_with("MPLAUC") { id[4..].to_owned() } else { id };
    if !valid_id(&id) { return None; }
    let release_date = find(item, "releaseDate", 0).and_then(|date| {
        if let Some(date) = date.as_str() { chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok() }
        else { chrono::NaiveDate::from_ymd_opt(date["year"].as_i64()? as i32, date["month"].as_u64()? as u32, date["day"].as_u64()? as u32) }
    }).map(|date| date.to_string());
    let track_count = runs.into_iter().flatten().find_map(|run| {
        let label = run["text"].as_str()?.trim();
        let (count, unit) = label.split_once(' ')?;
        if !matches!(unit, "song" | "songs" | "track" | "tracks") { return None; }
        count.replace(',', "").parse::<u32>().ok()
    });
    let explicit = find(&item["badges"], "musicInlineBadgeRenderer", 0)
        .or_else(|| find(&item["subtitleBadges"], "musicInlineBadgeRenderer", 0))
        .and_then(|badge| (badge["icon"]["iconType"] == "MUSIC_EXPLICIT_BADGE").then_some(true));
    let track_number = item.get("index").map(text).and_then(|text| text.parse::<u32>().ok());
    let view_count = item.get("viewCount").and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()));
    Some(Item { id, kind: kind.into(), title, description: text(subtitle), artist: artists.join(", "), artist_credits, thumbnail: thumbnail(item), duration, album, year, release_date, track_count,
        album_id, artist_id, track_number, explicit, view_count, liked: liked(item),
        video_type: watch.and_then(|watch| find(watch, "musicVideoType", 0)).and_then(Value::as_str).map(str::to_owned),
        playlist_item_id: item.pointer("/playlistItemData/playlistSetVideoId").or_else(|| find(item, "setVideoId", 0)).and_then(Value::as_str).map(str::to_owned), unavailable: false })
}

fn items(value: &Value, output: &mut Vec<Item>, collection: bool, depth: usize) {
    collect_items(value, output, collection, false, depth)
}

fn collect_items(value: &Value, output: &mut Vec<Item>, collection: bool, live: bool, depth: usize) {
    if depth > 40 || output.len() >= 1000 { return; }
    if value.get("musicResponsiveListItemRenderer").is_some() || value.get("musicTwoRowItemRenderer").is_some() || value.get("playlistPanelVideoRenderer").is_some() {
        if let Some(item) = card(value, collection, live) { output.push(item); }
        return;
    }
    if let Some(shelf) = value.get("musicCardShelfRenderer") {
        // Search's top result is the shelf itself. It may also contain ordinary
        // result rows; keep those without traversing its buttons or menus.
        if let Some(item) = card(value, collection, live) { output.push(item); }
        collect_items(&shelf["contents"], output, collection, live, depth + 1);
        return;
    }
    match value {
        Value::Array(values) => for value in values { collect_items(value, output, collection, live, depth + 1); },
        Value::Object(map) => for (key, value) in map {
            if !matches!(key.as_str(), "menu" | "header" | "trackingParams" | "musicDescriptionShelfRenderer") {
                collect_items(value, output, collection, live, depth + 1);
            }
        },
        _ => {}
    }
}

fn continuation(value: &Value) -> Option<String> {
    find(value, "nextContinuationData", 0).and_then(|v| v["continuation"].as_str())
        .or_else(|| find(value, "nextRadioContinuationData", 0).and_then(|v| v["continuation"].as_str()))
        .or_else(|| find(value, "continuationCommand", 0).and_then(|v| v["token"].as_str()))
        .filter(|token| !token.is_empty() && token.len() <= 16384).map(str::to_owned)
}

fn excluded(title: &str) -> bool {
    let title = title.to_lowercase();
    ["shorts", "music video", "videos", "podcast", "episodes", "watch", "audiobook"].iter().any(|word| title.contains(word))
}

fn shelves(value: &Value, output: &mut Vec<Shelf>, depth: usize) {
    if depth > 40 || output.len() >= 40 { return; }
    if let Some(shelf) = value.get("musicCarouselShelfRenderer") {
        let header = &shelf["header"]["musicCarouselShelfBasicHeaderRenderer"];
        let title = text(&header["title"]);
        if title.is_empty() || excluded(&title) { return; }
        let lower = title.to_lowercase();
        let mut category = if lower.contains("new release") || lower.contains("new album") || lower.contains("latest release") { "releases" }
            else if lower.contains("mix") || lower.contains("daily discover") { "mixes" }
            else if lower.contains("listen again") || lower.contains("recently played") { "recent" } else { "music" };
        let mut contents = Vec::new();
        items(&shelf["contents"], &mut contents, false, 0);
        if category == "mixes" {
            if contents.iter().any(|item| item.kind == "playlist") {
                contents.retain(|item| item.kind == "playlist");
            } else { category = "music"; }
        }
        if !contents.is_empty() {
            let destination = destination(&header["title"]).or_else(|| destination(&header["moreContentButton"]));
            let identity = format!("{}:{}:{}", title.to_lowercase(), destination.as_ref().map(|d| d.browse_id.as_str()).unwrap_or_default(),
                destination.as_ref().and_then(|d| d.params.as_deref()).unwrap_or_default());
            output.push(Shelf { id: format!("ytmusic:{}", hex::encode(Sha1::digest(identity.as_bytes()))), title,
                category: category.into(), items: contents, destination, continuation: continuation(&shelf["continuations"]) });
        }
        return;
    }
    match value {
        Value::Array(list) => for value in list { shelves(value, output, depth + 1); },
        Value::Object(map) => for value in map.values() { shelves(value, output, depth + 1); },
        _ => {}
    }
}

pub(super) fn parse(response: &Value, home: bool, album: bool, performances: bool) -> BrowsePage {
    let mut hubs = Vec::new();
    if home { shelves(response, &mut hubs, 0); }
    let mut contents = Vec::new();
    let body = find(response, "musicPlaylistShelfRenderer", 0)
        .or_else(|| find(response, "musicShelfRenderer", 0))
        .or_else(|| find(response, "musicPlaylistShelfContinuation", 0))
        .or_else(|| find(response, "musicShelfContinuation", 0))
        .or_else(|| find(response, "playlistPanelRenderer", 0))
        .or_else(|| find(response, "playlistPanelContinuation", 0))
        .or_else(|| find(response, "gridRenderer", 0))
        .or_else(|| find(response, "gridContinuation", 0))
        .unwrap_or(response);
    let carousel_continuation = find(response, "musicCarouselShelfContinuation", 0);
    if !home { collect_items(body, &mut contents, true, performances, 0); }
    else if let Some(shelf) = carousel_continuation { items(shelf, &mut contents, false, 0); }
    let next = if let Some(shelf) = carousel_continuation { continuation(shelf) } else if home {
        find(response, "sectionListRenderer", 0).or_else(|| find(response, "sectionListContinuation", 0))
            .and_then(|list| continuation(&list["continuations"]))
    } else { continuation(body) };
    let header = find(response, "musicResponsiveHeaderRenderer", 0)
        .or_else(|| find(response, "musicDetailHeaderRenderer", 0))
        .or_else(|| find(response, "musicImmersiveHeaderRenderer", 0))
        .or_else(|| find(response, "musicVisualHeaderRenderer", 0)).unwrap_or(&response["header"]);
    let title = find(header, "title", 0).or_else(|| body.get("title")).map(text).unwrap_or_default();
    let cover = thumbnail(header);
    let artists = find(header, "straplineTextOne", 0).map(text).unwrap_or_default();
    for item in &mut contents {
        if item.kind == "song" {
            if item.thumbnail.is_none() { item.thumbnail = cover.clone(); }
            if item.artist.is_empty() { item.artist = artists.clone(); }
            if item.album.is_none() && album { item.album = Some(title.clone()); }
        }
    }
    let description = find(header, "description", 0).or_else(|| find(header, "descriptionText", 0)).map(text).filter(|text| !text.is_empty());
    BrowsePage { title, items: contents, hubs, continuation: next, thumbnail: cover, description, artist: None, lyrics: None }
}

fn artist_category(title: &str) -> &'static str {
    let title = title.to_lowercase();
    if title.contains("fans might") || title.contains("similar artist") || title.contains("related artist") { "similar" }
    else if title.contains("single") || title.contains("eps") { "singles" }
    else if title.contains("live") || title.contains("performance") { "live" }
    else if title.contains("featured on") || title.contains("features on") || title.contains("appears on") || title.contains("featured in") { "features" }
    else if title.contains("playlist") { "playlists" }
    else if title.contains("album") { "albums" }
    else if title.contains("song") || title.contains("track") { "songs" }
    else { "music" }
}

fn artist_shelves(value: &Value, output: &mut Vec<Shelf>, depth: usize) {
    if depth > 40 || output.len() >= 40 { return; }
    if let Some(shelf) = value.get("musicCarouselShelfRenderer").or_else(|| value.get("musicShelfRenderer")) {
        let header = shelf.pointer("/header/musicCarouselShelfBasicHeaderRenderer").unwrap_or(shelf);
        let title = text(&header["title"]);
        let category = artist_category(&title);
        if title.is_empty() || excluded(&title) { return; }
        let mut contents = Vec::new();
        collect_items(&shelf["contents"], &mut contents, true, category == "live", 0);
        let category = if contents.iter().all(|item| item.kind == "artist") { "similar" } else { category };
        contents.retain(|item| match category {
            "albums" | "singles" => item.kind == "album",
            "features" => item.kind != "artist",
            "similar" => item.kind == "artist",
            "playlists" => item.kind == "playlist",
            "songs" => item.kind == "song",
            _ => true,
        });
        if contents.is_empty() { return; }
        let destination = destination(&header["title"]).or_else(|| destination(&header["moreContentButton"]))
            .or_else(|| destination(&shelf["bottomEndpoint"]));
        let identity = format!("artist:{category}:{title}:{}", destination.as_ref().map(|d| d.browse_id.as_str()).unwrap_or_default());
        output.push(Shelf { id: format!("ytmusic:{}", hex::encode(Sha1::digest(identity.as_bytes()))), title,
            category: category.into(), items: contents, destination, continuation: continuation(&shelf["continuations"]) });
        return;
    }
    match value {
        Value::Array(list) => for value in list { artist_shelves(value, output, depth + 1); },
        Value::Object(map) => for (key, value) in map { if !matches!(key.as_str(), "header" | "menu") { artist_shelves(value, output, depth + 1); } },
        _ => {},
    }
}

fn artist_page(response: &Value, id: &str, page: &mut BrowsePage) {
    let header = find(response, "musicImmersiveHeaderRenderer", 0)
        .or_else(|| find(response, "musicVisualHeaderRenderer", 0))
        .or_else(|| find(response, "musicHeaderRenderer", 0)).unwrap_or(&response["header"]);
    let name = text(&header["title"]);
    if name.is_empty() { return; }
    let description = find(response, "musicDescriptionShelfRenderer", 0).map(|shelf| text(&shelf["description"]))
        .filter(|value| !value.is_empty()).or_else(|| page.description.clone());
    page.title = name.clone();
    page.description = description.clone();
    page.hubs.clear();
    artist_shelves(&response["contents"], &mut page.hubs, 0);
    for shelf in &mut page.hubs {
        for item in &mut shelf.items {
            if matches!(shelf.category.as_str(), "songs" | "albums" | "singles" | "live") && matches!(item.kind.as_str(), "song" | "album") && item.artist.is_empty() {
                item.artist = name.clone();
                item.artist_id = Some(id.into());
            }
        }
    }
    page.items = page.hubs.iter().filter(|shelf| shelf.category == "songs").flat_map(|shelf| shelf.items.clone()).collect();
    let playlist = |value: &Value| find(value, "playlistId", 0).and_then(Value::as_str)
        .filter(|id| valid_id(id)).map(|id| Destination { browse_id: format!("VL{id}"), params: None });
    let channel_id = header.pointer("/subscriptionButton/subscribeButtonRenderer/channelId").and_then(Value::as_str)
        .filter(|id| id.starts_with("UC") && valid_id(id)).map(str::to_owned);
    page.artist = Some(Artist { id: id.into(), channel_id, name,
        thumbnail: thumbnail(&header["foregroundThumbnail"]).or_else(|| thumbnail(header)), background: thumbnail(header), description,
        monthly_listeners: Some(text(&header["monthlyListenerCount"])).filter(|value| !value.is_empty()),
        subscribers: find(header, "subscriberCountText", 0).map(text).filter(|value| !value.is_empty()),
        songs: page.hubs.iter().find(|shelf| shelf.category == "songs").and_then(|shelf| shelf.destination.clone()),
        shuffle: playlist(&header["playButton"]),
    });
    page.continuation = None;
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Query {
    browse_id: String,
    params: Option<String>,
    continuation: Option<String>,
    include_performances: bool,
}

#[derive(Clone)]
struct CatalogRequest {
    query: Query,
    generation: u64,
    cache_epoch: u64,
    directory: Option<std::path::PathBuf>,
    key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Update {
    #[serde(flatten)]
    query: Query,
    client_revision: Option<u64>,
    page: BrowsePage,
}

impl CatalogRequest {
    async fn saved(&self, state: &YoutubeMusic) -> Option<discovery_cache::Saved> {
        let path = self.directory.as_ref()?.join(format!("{}.json", self.key.as_ref()?));
        state.discovery_cache.read(path).await
    }

    async fn cached(&self, app: &tauri::AppHandle, client_revision: Option<u64>) -> Result<Option<BrowsePage>, String> {
        let state = app.state::<Arc<YoutubeMusic>>();
        let Some(saved) = self.saved(&state).await else { return Ok(None); };
        if !state.owns(self.generation) { return Err("YouTube Music connection changed.".into()); }
        if !saved.fresh {
            let key = self.key.as_deref().unwrap_or(&self.query.browse_id);
            let lock = state.discovery_cache.request(key);
            if let Ok(guard) = lock.try_lock_owned() {
                if state.discovery_cache.begin_refresh(key) {
                    let app = app.clone();
                    let request = self.clone();
                    let previous = saved.page.clone();
                    crate::background_jobs::advisory(crate::background_jobs::Lane::Refresh, "Refreshing YTM catalog", async move {
                        let _guard = guard;
                        if let Ok(page) = fetch(&app, &request).await {
                            let state = app.state::<Arc<YoutubeMusic>>();
                            if state.owns(request.generation) && serde_json::to_value(&previous).ok() != serde_json::to_value(&page).ok() {
                                let _ = app.emit_to("main", "ytmusic://catalog", Update { query: request.query, client_revision, page });
                            }
                        }
                    });
                }
            }
        }
        Ok(Some(saved.page))
    }
}

fn catalog_request(app: &tauri::AppHandle, id: &str, params: Option<&str>, token: Option<&str>,
    performances: bool) -> Result<CatalogRequest, String> {
    if !valid_id(id) || params.is_some_and(|p| p.len() > 16384) || token.is_some_and(|t| t.is_empty() || t.len() > 16384) {
        return Err("Invalid YouTube Music collection.".into());
    }
    let search = matches!(id, "hibiki_artist_search" | "hibiki_song_search" | "hibiki_search");
    if matches!(id, "hibiki_song_like" | "hibiki_song_metadata" | "hibiki_song_lyrics") && (params.is_none_or(|id| !api::valid_video_id(id)) || token.is_some()) {
        return Err("Choose a valid YouTube Music song.".into());
    }
    if search && (params.is_none_or(|query| query.trim().is_empty() || query.len() > 500) || token.is_some()) {
        return Err("Choose a valid artist name.".into());
    }
    let state = app.state::<Arc<YoutubeMusic>>();
    let cache_id = if performances { format!("performances:{id}") } else { id.to_owned() };
    // Older search snapshots omitted the featured result. Leave other catalog
    // caches intact, but fetch search data again with the complete parser.
    let cache_id = format!("credits-v1:{}", if search { format!("search-v2:{cache_id}") } else { cache_id });
    Ok(CatalogRequest {
        query: Query { browse_id: id.into(), params: params.map(str::to_owned), continuation: token.map(str::to_owned), include_performances: performances },
        generation: state.generation()?, cache_epoch: state.discovery_cache.epoch(),
        directory: app.path().app_cache_dir().ok().map(|directory| directory.join("ytmusic-discovery")),
        key: playback::cache_owner(app).ok().map(|owner| discovery_cache::key(&owner, &cache_id, params, token)),
    })
}

/// Cached matching lookups are reads, not new Butler jobs. Stale pages keep the
/// same coalesced SWR refresh as foreground browsing; misses enter the queue.
pub(super) async fn cached_browse(app: &tauri::AppHandle, id: &str, params: Option<&str>, token: Option<&str>,
    performances: bool, client_revision: Option<u64>) -> Result<Option<BrowsePage>, String> {
    catalog_request(app, id, params, token, performances)?.cached(app, client_revision).await
}

pub async fn browse(app: &tauri::AppHandle, id: &str, params: Option<&str>, token: Option<&str>, force: bool,
    performances: bool, client_revision: Option<u64>) -> Result<BrowsePage, String> {
    let request = catalog_request(app, id, params, token, performances)?;
    if !force {
        if let Some(page) = request.cached(app, client_revision).await? { return Ok(page); }
    }
    let state = app.state::<Arc<YoutubeMusic>>();
    let lock = state.discovery_cache.request(request.key.as_deref().unwrap_or(id));
    let _guard = lock.lock().await;
    if !state.owns(request.generation) { return Err("YouTube Music connection changed.".into()); }
    let previous = request.saved(&state).await;
    if !force {
        if let Some(saved) = previous.as_ref().filter(|saved| saved.fresh) { return Ok(saved.page.clone()); }
    }
    let page = fetch(app, &request).await?;
    if previous.is_some_and(|saved| serde_json::to_value(&saved.page).ok() != serde_json::to_value(&page).ok()) {
        let _ = app.emit_to("main", "ytmusic://catalog", Update { query: request.query, client_revision, page: page.clone() });
    }
    Ok(page)
}

async fn fetch(app: &tauri::AppHandle, request: &CatalogRequest) -> Result<BrowsePage, String> {
    crate::background_jobs::report("Fetching YTM catalog", None, 0, None, "pages").await?;
    let state = app.state::<Arc<YoutubeMusic>>();
    let generation = request.generation;
    if !state.owns(generation) { return Err("YouTube Music connection changed.".into()); }
    let id = request.query.browse_id.as_str();
    let params = request.query.params.as_deref();
    let token = request.query.continuation.as_deref();
    let artist_search = id == "hibiki_artist_search";
    let song_search = id == "hibiki_song_search";
    let general_search = id == "hibiki_search";
    let song_like = id == "hibiki_song_like";
    let song_metadata = id == "hibiki_song_metadata";
    let song_lyrics = id == "hibiki_song_lyrics";
    let cookies = session::cookies(app).await?;
    let context = api::context(app).await.map_err(|e| if e.auth { e.report(app, generation) } else { e.message.into() })?;
    // Personalized watch mixes are queues, rather than browseable library playlists.
    let radio = id.starts_with("VLRD");
    let mut body = if radio { json!({ "playlistId": &id[2..], "isAudioOnly": true,
        "enablePersistentPlaylistPanel": true, "tunerSettingValue": "AUTOMIX_SETTING_NORMAL" }) }
        else { json!({ "browseId": id }) };
    if let Some(video_id) = id.strip_prefix("VLRDAMVM").filter(|id| api::valid_video_id(id)) {
        body["videoId"] = json!(video_id);
    }
    if song_like || song_metadata || song_lyrics {
        body = json!({ "videoId": params.unwrap_or_default(), "playlistId": format!("RDAMVM{}", params.unwrap_or_default()),
            "isAudioOnly": true, "enablePersistentPlaylistPanel": true });
    } else if general_search {
        body = json!({ "query": params.unwrap_or_default() });
    } else if artist_search || song_search {
        // Artist-only search. The caller checks name confidence and catalog
        // evidence instead of accepting the first search result.
        body = json!({ "query": params.unwrap_or_default(), "params": if artist_search { "EgWKAQIgAWoMEA4QChADEAQQCRAF" }
            else { "EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D" } });
    } else if let Some(params) = params { body["params"] = json!(params); }
    if let Some(token) = token { body["continuation"] = json!(token); }
    let fallback_ttl = if id.starts_with("UC") || id.starts_with("MPRE") { 6 * 3600 }
        else if radio || matches!(id, "FEmusic_home" | "FEmusic_history") { 5 * 60 } else { 15 * 60 };
    let mut response = api::request_with_policy(&context, &cookies, if general_search || artist_search || song_search { "search" } else if radio || song_like || song_metadata || song_lyrics { "next" } else { "browse" }, body, fallback_ttl)
        .await.map_err(|e| if e.auth { e.report(app, generation) } else { e.message.into() })?;
    if !state.owns(generation) { return Err("YouTube Music connection changed.".into()); }
    let mut page = parse(&response.value, id == "FEmusic_home", id.starts_with("MPRE"), request.query.include_performances);
    if song_lyrics {
        let (lyrics, policy) = super::lyrics::load(app, generation, &context, &cookies, &response.value).await?;
        page.lyrics = Some(lyrics);
        if let Some(policy) = policy { response.policy = policy; }
        page.items.clear();
        page.hubs.clear();
        page.continuation = None;
    }
    if id.starts_with("MPRE") {
        for item in &mut page.items {
            if item.kind == "song" && item.album_id.is_none() && item.album.as_deref() == Some(page.title.as_str()) {
                item.album_id = Some(id.into());
            }
        }
    }
    if song_like || song_metadata {
        page.items.retain(|item| item.kind == "song" && Some(item.id.as_str()) == params && (!song_like || item.liked.is_some()));
        page.hubs.clear();
        page.continuation = None;
        if page.items.is_empty() { return Err("Could not read this song's YouTube Music metadata. Try again.".into()); }
    }
    if id == "VLLM" { for item in &mut page.items { if item.kind == "song" { item.liked = Some(true); } } }
    if general_search || artist_search {
        page.items = search_items(&response.value, artist_search);
        page.continuation = None;
    }
    if id == "FEmusic_history" {
        // History groups songs by day; a first-shelf lookup would only show one day.
        let list = find(&response.value, "sectionListRenderer", 0).or_else(|| find(&response.value, "sectionListContinuation", 0)).unwrap_or(&response.value);
        page.items.clear();
        items(list, &mut page.items, true, 0);
        page.continuation = continuation(&list["continuations"]);
    }
    if id.starts_with("UC") && params.is_none() && token.is_none() { artist_page(&response.value, id, &mut page); }
    if let (Some(directory), Some(key)) = (&request.directory, &request.key) {
        state.discovery_cache.write(directory.clone(), key.clone(), id.into(), page.clone(), response.policy, request.cache_epoch).await;
    }
    if !state.owns(generation) { return Err("YouTube Music connection changed.".into()); }
    Ok(page)
}

fn search_items(response: &Value, artists_only: bool) -> Vec<Item> {
    let mut results = Vec::new();
    collect_items(&response["contents"], &mut results, true, false, 0);
    results.retain(|item| if artists_only { item.kind == "artist" }
        else { matches!(item.kind.as_str(), "artist" | "album" | "song" | "playlist") });
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    fn song(id: &str, video_type: &str) -> Value {
        json!({"musicTwoRowItemRenderer": {"title":{"runs":[{"text":"Song"}]}, "navigationEndpoint":{"watchEndpoint":{
            "videoId":id,"watchEndpointMusicSupportedConfigs":{"watchEndpointMusicConfig":{"musicVideoType":video_type}}}}}})
    }
    fn album() -> Value {
        json!({"musicTwoRowItemRenderer":{"title":{"runs":[{"text":"Album","navigationEndpoint":{"browseEndpoint":{
            "browseId":"MPREb_test","browseEndpointContextSupportedConfigs":{"browseEndpointContextMusicConfig":{"pageType":"MUSIC_PAGE_TYPE_ALBUM"}}}}}]},
            "subtitle":{"runs":[{"text":"f5ve","navigationEndpoint":{"browseEndpoint":{"browseId":"UC_artist"}}},{"text":"2026"}]},
            "releaseDate":{"year":2026,"month":10,"day":16}}})
    }
    fn shelf(title: &str, contents: Vec<Value>) -> Value {
        json!({"musicCarouselShelfRenderer":{"header":{"musicCarouselShelfBasicHeaderRenderer":{"title":{"runs":[{"text":title}]}}},"contents":contents,
            "continuations":[{"nextContinuationData":{"continuation":"shelf-token"}}]}})
    }
    #[test]
    fn plain_search_performer_does_not_include_release_or_duration() {
        let row = json!({"musicResponsiveListItemRenderer":{
            "flexColumns":[
                {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Kalinka!","navigationEndpoint":{"watchEndpoint":{"videoId":"abcdefghijk"}}}]}}},
                {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Unicorn on K"},{"text":" • "},
                    {"text":"Kalinka!","navigationEndpoint":{"browseEndpoint":{"browseId":"MPRE_album"}}},{"text":" • "},{"text":"2:31"}]}}}
            ]
        }});
        let song = card(&row, true, false).unwrap();
        assert_eq!(song.artist, "Unicorn on K");
        assert_eq!(song.artist_credits.len(), 1);
        assert_eq!(song.artist_credits[0].name, "Unicorn on K");
        assert_eq!(song.album.as_deref(), Some("Kalinka!"));
        assert_eq!(song.duration.as_deref(), Some("2:31"));
    }
    #[test]
    fn artist_popularity_is_not_release_metadata_and_credits_keep_individual_ids() {
        let row = |release: Value| json!({"musicResponsiveListItemRenderer":{
            "flexColumns":[
                {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Song","navigationEndpoint":{"watchEndpoint":{"videoId":"abcdefghijk"}}}]}}},
                {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[
                    {"text":"A","navigationEndpoint":{"browseEndpoint":{"browseId":"UC_first"}}},
                    {"text":", "},{"text":"B","navigationEndpoint":{"browseEndpoint":{"browseId":"UC_second"}}}
                ]}}},
                {"musicResponsiveListItemFlexColumnRenderer":{"text":release}}
            ]
        }});
        let popularity = card(&row(json!({"runs":[{"text":"1.2M plays"}]})), true, false).unwrap();
        assert!(popularity.album.is_none());
        assert!(popularity.album_id.is_none());
        assert_eq!(popularity.artist_credits.len(), 2);
        assert_eq!(popularity.artist_credits[1].id.as_deref(), Some("UC_second"));
        let release = card(&row(json!({"runs":[{"text":"Release","navigationEndpoint":{"browseEndpoint":{"browseId":"MPRE_album"}}}]})), true, false).unwrap();
        assert_eq!(release.album.as_deref(), Some("Release"));
        assert_eq!(release.album_id.as_deref(), Some("MPRE_album"));
    }
    #[test]
    fn radio_continuation_keeps_audio_tracks_and_its_own_cursor() {
        let panel = |id: &str, video_type: &str| json!({"playlistPanelVideoRenderer":{
            "videoId":id,"title":{"simpleText":"Song"},"shortBylineText":{"simpleText":"Artist"},
            "lengthText":{"simpleText":"3:00"},"longBylineText":{"runs":[
                {"text":"Artist","navigationEndpoint":{"browseEndpoint":{"browseId":"UC_artist"}}},
                {"text":"Album","navigationEndpoint":{"browseEndpoint":{"browseId":"MPRE_album"}}}]},"navigationEndpoint":{"watchEndpoint":{
                "watchEndpointMusicSupportedConfigs":{"watchEndpointMusicConfig":{"musicVideoType":video_type}}}}
        }});
        let response = json!({"continuationContents":{"playlistPanelContinuation":{
            "contents":[panel("abcdefghijk", "MUSIC_VIDEO_TYPE_ATV"),panel("lmnopqrstuv", "MUSIC_VIDEO_TYPE_OMV")],
            "continuations":[{"nextRadioContinuationData":{"continuation":"radio-next"}}]
        }},"other":{"nextContinuationData":{"continuation":"unrelated-token"}}});
        let page = parse(&response, false, false, false);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "abcdefghijk");
        assert_eq!(page.items[0].video_type.as_deref(), Some("MUSIC_VIDEO_TYPE_ATV"));
        let unfiltered = parse(&response, false, false, true);
        assert_eq!(unfiltered.items.len(), 2);
        assert_eq!(unfiltered.items[1].video_type.as_deref(), Some("MUSIC_VIDEO_TYPE_OMV"));
        assert_eq!(page.items[0].artist, "Artist");
        assert_eq!(page.items[0].artist_id.as_deref(), Some("UC_artist"));
        assert_eq!(page.items[0].album_id.as_deref(), Some("MPRE_album"));
        assert_eq!(page.items[0].album.as_deref(), Some("Album"));
        assert_eq!(page.continuation.as_deref(), Some("radio-next"));
    }
    #[test]
    fn song_like_state_uses_current_status_or_the_inverse_watch_menu_action() {
        assert_eq!(liked(&json!({"menu":{"likeButtonRenderer":{"likeStatus":"LIKE"}}})), Some(true));
        assert_eq!(liked(&json!({"menu":{"likeButtonRenderer":{"likeStatus":"DISLIKE"}}})), Some(false));
        for (status, expected) in [("LIKE", false), ("INDIFFERENT", true)] {
            let item = json!({"menu":{"menuRenderer":{"items":[{"toggleMenuServiceItemRenderer":{
                "defaultServiceEndpoint":{"likeEndpoint":{"status":status}}
            }}]}}});
            assert_eq!(liked(&item), Some(expected));
        }
        // A nested recommendation's state cannot become the featured song's.
        assert_eq!(liked(&json!({"contents":[{"likeStatus":"LIKE"}]})), None);
    }
    #[test]
    fn normal_search_keeps_playlists_alongside_artists_albums_and_audio_from_one_response() {
        let artist = json!({"musicTwoRowItemRenderer":{"title":{"runs":[{"text":"Artist"}]},
            "navigationEndpoint":{"browseEndpoint":{"browseId":"UC_artist"}}}});
        let playlist = json!({"musicResponsiveListItemRenderer":{
            "flexColumns":[{"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Partial Playlist"}]}}},
                {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"12 songs"}]}}}],
            "navigationEndpoint":{"browseEndpoint":{"browseId":"VLPL_playlist",
                "browseEndpointContextSupportedConfigs":{"browseEndpointContextMusicConfig":{"pageType":"MUSIC_PAGE_TYPE_PLAYLIST"}}}},
            "thumbnail":{"musicThumbnailRenderer":{"thumbnail":{"thumbnails":[{"url":"https://lh3.googleusercontent.com/playlist","width":512,"height":512}]}}}
        }});
        let response = json!({"contents":{"sectionListRenderer":{"contents":[
            shelf("Artists", vec![artist]), shelf("Albums", vec![album()]),
            shelf("Songs", vec![song("abcdefghijk", "MUSIC_VIDEO_TYPE_ATV"), song("lmnopqrstuv", "MUSIC_VIDEO_TYPE_OMV")]),
            shelf("Playlists", vec![playlist])
        ]}}});
        let items = search_items(&response, false);
        assert_eq!(items.iter().map(|item| item.kind.as_str()).collect::<Vec<_>>(), ["artist", "album", "song", "playlist"]);
        assert_eq!(items[3].id, "VLPL_playlist");
        assert_eq!(items[3].track_count, Some(12));
        assert_eq!(items[3].thumbnail.as_deref(), Some("https://lh3.googleusercontent.com/playlist"));
        assert_eq!(search_items(&response, true).len(), 1);
    }
    #[test]
    fn artist_search_recognizes_channel_aliases_without_accepting_other_page_types() {
        for page_type in ["MUSIC_PAGE_TYPE_ARTIST", "MUSIC_PAGE_TYPE_USER_CHANNEL"] {
            for id in ["UC_katseye", "MPLAUC_katseye"] {
                let value = json!({"musicResponsiveListItemRenderer":{
                    "flexColumns":[{"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"KATSEYE"}]}}}],
                    "navigationEndpoint":{"browseEndpoint":{"browseId":id,
                        "browseEndpointContextSupportedConfigs":{"browseEndpointContextMusicConfig":{"pageType":page_type}}}}
                }});
                let item = card(&value, true, false).unwrap();
                assert_eq!(item.kind, "artist");
                assert_eq!(item.id, "UC_katseye");
            }
        }
    }
    #[test]
    fn search_keeps_the_featured_artist_and_its_nested_song_results() {
        for browse_id in ["UC_winking_owl", "MPLAUC_winking_owl"] {
            let response = json!({"contents":{"tabbedSearchResultsRenderer":{"tabs":[{"tabRenderer":{"content":{
                "sectionListRenderer":{"contents":[{"musicCardShelfRenderer":{
                    "title":{"runs":[{"text":"The Winking Owl","navigationEndpoint":{"browseEndpoint":{"browseId":browse_id}}}]},
                    "subtitle":{"runs":[{"text":"Artist"}]},
                    "thumbnail":{"musicThumbnailRenderer":{"thumbnail":{"thumbnails":[
                        {"url":"https://lh3.googleusercontent.com/winking-owl","width":512,"height":512}]}}},
                    "contents":[song("abcdefghijk", "MUSIC_VIDEO_TYPE_ATV")],
                    "menu":{"contents":[song("lmnopqrstuv", "MUSIC_VIDEO_TYPE_ATV")]}
                }}]}
            }}}]}}});
            let mut results = Vec::new();
            collect_items(&response["contents"], &mut results, true, false, 0);
            assert_eq!(results.len(), 2);
            assert_eq!(results[0].kind, "artist");
            assert_eq!(results[0].id, "UC_winking_owl");
            assert_eq!(results[0].title, "The Winking Owl");
            assert_eq!(results[0].thumbnail.as_deref(), Some("https://lh3.googleusercontent.com/winking-owl"));
            assert_eq!(results[1].id, "abcdefghijk");
        }
    }
    #[test]
    fn search_top_song_uses_its_tap_endpoint_and_still_excludes_music_videos() {
        let featured = |video_type: &str| json!({"musicCardShelfRenderer":{
            "title":{"runs":[{"text":"Featured song"}]},
            "subtitle":{"runs":[{"text":"Song"},{"text":" • "},{"text":"The Winking Owl",
                "navigationEndpoint":{"browseEndpoint":{"browseId":"UC_winking_owl"}}}]},
            "onTap":{"watchEndpoint":{"videoId":"abcdefghijk",
                "watchEndpointMusicSupportedConfigs":{"watchEndpointMusicConfig":{"musicVideoType":video_type}}}}
        }});
        let mut results = Vec::new();
        collect_items(&json!([featured("MUSIC_VIDEO_TYPE_ATV"), featured("MUSIC_VIDEO_TYPE_OMV")]), &mut results, true, false, 0);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].kind, "song");
        assert_eq!(results[0].id, "abcdefghijk");
        assert_eq!(results[0].artist, "The Winking Owl");
        assert_eq!(results[0].artist_id.as_deref(), Some("UC_winking_owl"));
    }
    #[test]
    fn home_keeps_music_rejects_videos_and_shorts_and_uses_the_outer_continuation() {
        let response = json!({"contents":{"sectionListRenderer":{"contents":[
            shelf("Your music", vec![song("abcdefghijk", "MUSIC_VIDEO_TYPE_ATV"), song("lmnopqrstuv", "MUSIC_VIDEO_TYPE_OMV"), album()]),
            shelf("Heard in Shorts", vec![song("lmnopqrstuv", "MUSIC_VIDEO_TYPE_ATV")])],
            "continuations":[{"nextContinuationData":{"continuation":"home-token"}}]}}});
        let page = parse(&response, true, false, false);
        assert_eq!(page.hubs.len(), 1);
        assert_eq!(page.hubs[0].category, "music");
        assert_eq!(page.hubs[0].items.len(), 2);
        assert_eq!(page.hubs[0].items[1].release_date.as_deref(), Some("2026-10-16"));
        assert_eq!(page.continuation.as_deref(), Some("home-token"));
        assert!(page.items.is_empty());
    }
    #[test]
    fn album_tracks_inherit_the_album_cover_and_artist_without_related_recommendations() {
        let flat = json!({"musicResponsiveListItemRenderer":{
            "flexColumns":[{"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Track"}]}}}],
            "overlay":{"musicItemThumbnailOverlayRenderer":{"content":{"musicPlayButtonRenderer":{"playNavigationEndpoint":{"watchEndpoint":{"videoId":"abcdefghijk"}}}}}}}});
        let response = json!({"header":{"musicResponsiveHeaderRenderer":{"title":{"runs":[{"text":"Album"}]},
            "straplineTextOne":{"runs":[{"text":"Artist"}]},"thumbnail":{"thumbnails":[{"url":"https://lh3.googleusercontent.com/cover","width":512,"height":512}]}}},
            "contents":{"musicShelfRenderer":{"contents":[flat],"continuations":[{"nextContinuationData":{"continuation":"songs-next"}}]}},
            "related":[album()]});
        let page = parse(&response, false, true, false);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].artist, "Artist");
        assert_eq!(page.items[0].album.as_deref(), Some("Album"));
        assert_eq!(page.items[0].thumbnail.as_deref(), Some("https://lh3.googleusercontent.com/cover"));
        assert_eq!(page.continuation.as_deref(), Some("songs-next"));
    }
    #[test]
    fn mix_shelves_only_contain_playlists_and_keep_generated_mix_covers_and_subtitles() {
        let playlist = json!({"musicTwoRowItemRenderer":{"title":{"runs":[{"text":"My Supermix"}]},
            "subtitle":{"runs":[{"text":"Charli xcx, f5ve and more"}]},
            "navigationEndpoint":{"watchPlaylistEndpoint":{"playlistId":"RDCLAKmix"}},
            "menu":{"thumbnails":[{"url":"https://example.invalid/not-the-cover","width":32,"height":32}]},
            "thumbnailRenderer":{"musicThumbnailRenderer":{"thumbnail":{"thumbnails":[
                {"url":"https://lh3.googleusercontent.com/real-mix-cover","width":640,"height":360}]}}}}});
        let response = json!([shelf("Mixed for You", vec![playlist, song("abcdefghijk", "MUSIC_VIDEO_TYPE_ATV")]),
            shelf("Mix up your listening", vec![song("abcdefghijk", "MUSIC_VIDEO_TYPE_ATV")])]);
        let page = parse(&response, true, false, false);
        assert_eq!(page.hubs[0].category, "mixes");
        assert_eq!(page.hubs[0].items.len(), 1);
        assert_eq!(page.hubs[0].items[0].title, "My Supermix");
        assert_eq!(page.hubs[0].items[0].description, "Charli xcx, f5ve and more");
        assert_eq!(page.hubs[0].items[0].thumbnail.as_deref(), Some("https://lh3.googleusercontent.com/real-mix-cover"));
        assert_eq!(page.hubs[1].category, "music");
    }
    #[test]
    fn generated_mix_artwork_keeps_its_composition_parameters() {
        let image = json!({"thumbnailRenderer":{"musicThumbnailRenderer":{"thumbnail":{"thumbnails":[
            {"url":"/image/mixart?r=artwork%2Fcomposition&size=544&it=1","width":544,"height":544}
        ]}}}});
        assert_eq!(thumbnail(&image).as_deref(), Some("https://music.youtube.com/image/mixart?r=artwork%2Fcomposition&size=544&it=1"));
        assert!(artwork_url("https://www.gstatic.com/youtube/media/ytm/images/mix.png").is_some());
        for rejected in ["https://music.youtube.com.evil.test/image/mixart", "https://music.youtube.com/watch?v=abc",
            "https://user:password@music.youtube.com/image/mixart", "http://music.youtube.com/image/mixart"] {
            assert!(artwork_url(rejected).is_none());
        }
    }
}
