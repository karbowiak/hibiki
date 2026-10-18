use super::{Lane, APP};
use crate::commands::PlexRequestContext;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Work {
    // Keep the envelope identity separate from identifiers on flattened tasks.
    // In particular Advisory owns an `id` for its in-memory closure.
    #[serde(rename = "workId", default = "work_id")]
    pub id: String,
    #[serde(flatten)]
    pub task: Task,
}
fn work_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
impl Work {
    pub(super) fn new(task: Task) -> Self {
        Self {
            id: work_id(),
            task,
        }
    }
}

/// Version job payloads when their meaning changes. Never persist credentials
/// or an instruction to repeat a provider mutation: persist a reconciliation
/// intent and let its domain journal verify the last write instead.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Task {
    Client {
        request: super::client::Request,
    },
    Advisory {
        id: String,
        lane: Lane,
        label: String,
    },
    ListeningOutbox,
    PlexMaintenance,
    PlexAnalysis {
        context: PlexRequestContext,
    },
    YoutubeSessionMaintenance,
    PlexRequestedDownloads {
        context: PlexRequestContext,
    },
    PlexDownloads {
        context: PlexRequestContext,
    },
    YoutubeDownloads {
        scope: String,
        generation: u64,
    },
    YoutubeAudioProbe {
        video_id: String,
        account: String,
        generation: u64,
    },
    PlexMatchingIndex {
        context: PlexRequestContext,
    },
    YoutubeBrowse {
        request: Browse,
    },
    YoutubePlaylistRead {
        playlist_id: String,
        account: String,
        generation: u64,
        #[serde(default)]
        source_only: bool,
    },
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Browse {
    pub account: String,
    pub generation: u64,
    pub browse_id: String,
    pub params: Option<String>,
    pub continuation: Option<String>,
    pub force: bool,
    pub include_performances: bool,
    pub client_revision: Option<u64>,
}
impl Task {
    pub(super) fn label(&self) -> &str {
        match self {
            Self::Client { request } => match request.domain.as_str() {
                "mixed" if request.method == "retryIndexedMatches" => "Checking playlist matches",
                "mixed" => "Playlist matching and sync",
                "linked" => "ListenBrainz playlist sync",
                "favorites" if request.method == "matchMissing" => "Matching liked songs",
                "favorites" => "Syncing liked songs",
                "ratings" => "Rating sync",
                "collections" if request.method == "hydrateYoutubeMusic" => "Caching YTM playlists",
                "collections" => "Caching Plex collections",
                "metadata" => "Refreshing Plex metadata",
                _ => "Background work",
            },
            Self::Advisory { label, .. } => label,
            Self::ListeningOutbox => "Listening history sync",
            Self::PlexMaintenance => "Checking Plex background work",
            Self::PlexAnalysis { .. } => "Saved audio analysis",
            Self::YoutubeSessionMaintenance => "Refreshing YTM sign-in",
            Self::PlexRequestedDownloads { .. } => "Refreshing Plex downloads",
            Self::PlexDownloads { .. } => "Plex downloads",
            Self::YoutubeDownloads { .. } => "YouTube Music downloads",
            Self::YoutubeAudioProbe { .. } => "Checking YTM audio quality",
            Self::PlexMatchingIndex { .. } => "Plex matching index",
            Self::YoutubeBrowse { .. } => "YTM catalog matching",
            Self::YoutubePlaylistRead { .. } => "Checking YTM playlist",
        }
    }
    pub(super) fn activity_id(&self) -> Option<String> {
        Some(match self {
            Self::Client { request } => match request.domain.as_str() {
                "mixed" if request.method == "retryIndexedMatches" => "playlist-matches".into(),
                "mixed" => format!("mixed:{}", request.args.get(0)?.as_str()?),
                "linked" => format!("linked:{}", request.args.get(0)?.as_str()?),
                "favorites" if request.method == "matchMissing" => "favorite-matching".into(),
                "favorites" => "favorites".into(),
                "ratings" => "ytmusic-ratings".into(),
                "collections" => {
                    format!("collection:{}", request.args.get(0)?.get("key")?.as_str()?)
                }
                _ => return None,
            },
            Self::PlexMatchingIndex { .. } => "matching-index".into(),
            Self::PlexDownloads { .. } => "downloads".into(),
            Self::YoutubeDownloads { .. } => "downloads:ytmusic".into(),
            Self::PlexAnalysis { .. } => "audio-analysis".into(),
            Self::Advisory { lane, label, .. } => format!("advisory:{}:{label}", lane.name()),
            _ => return None,
        })
    }
    pub(super) fn name(&self) -> &'static str {
        match self {
            Self::Client { .. } => "hibiki.client.v1",
            Self::Advisory { .. } => "hibiki.advisory.v1",
            Self::ListeningOutbox => NAMES[0],
            Self::PlexMaintenance => "hibiki.plex-maintenance.v1",
            Self::PlexAnalysis { .. } => "hibiki.plex-analysis.v1",
            Self::YoutubeSessionMaintenance => "hibiki.youtube-session.v1",
            Self::PlexRequestedDownloads { .. } => "hibiki.plex-requested-downloads.v1",
            Self::PlexDownloads { .. } => NAMES[1],
            Self::YoutubeDownloads { .. } => "hibiki.youtube-downloads.v2",
            Self::YoutubeAudioProbe { .. } => "hibiki.youtube-audio-probe.v1",
            Self::PlexMatchingIndex { .. } => "hibiki.plex-matching-index.v1",
            Self::YoutubeBrowse { .. } => "hibiki.youtube-browse.v1",
            Self::YoutubePlaylistRead { .. } => "hibiki.youtube-playlist-read.v1",
        }
    }
    pub(super) fn lane(&self) -> Lane {
        match self {
            Self::Client { request } => match request.domain.as_str() {
                "collections" => Lane::Hydration,
                "metadata" => Lane::Metadata,
                "mixed" => Lane::PlaylistSync,
                "linked" => Lane::LinkedSync,
                "favorites" => Lane::Favorites,
                "ratings" => Lane::Ratings,
                _ => Lane::Coordination,
            },
            Self::Advisory { lane, .. } => *lane,
            Self::ListeningOutbox => Lane::Reporting,
            Self::PlexMaintenance => Lane::Refresh,
            // This sweeps server metadata/levels, rather than decoding audio.
            // It must not monopolize the local waveform/CPU analysis lane.
            Self::PlexAnalysis { .. } => Lane::Metadata,
            Self::YoutubeSessionMaintenance | Self::PlexRequestedDownloads { .. } => Lane::Refresh,
            Self::PlexDownloads { .. } => Lane::Download,
            Self::YoutubeDownloads { .. } => Lane::Download,
            Self::YoutubeAudioProbe { .. } => Lane::Matching,
            Self::PlexMatchingIndex { .. } => Lane::Metadata,
            Self::YoutubeBrowse { .. } => Lane::Matching,
            Self::YoutubePlaylistRead { .. } => Lane::Sync,
        }
    }
    pub(super) fn schedule_key(&self) -> Result<String, String> {
        let mut task = self.clone();
        match &mut task {
            Self::PlexRequestedDownloads { context } => context.connection_revision = 0,
            _ => {}
        }
        task.key()
    }
    pub(super) fn key(&self) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        serde_json::to_vec(self)
            .map(|data| hex::encode(Sha256::digest(data)))
            .map_err(|_| "Background task could not be saved".into())
    }
}

// Distinct task names make Butler's diagnostics and per-type metrics useful,
// while sharing one versioned envelope decoder and account-fenced dispatcher.
pub(super) const NAMES: [&str; 14] = [
    "hibiki.listening-outbox.v1",
    "hibiki.plex-downloads.v1",
    "hibiki.plex-matching-index.v1",
    "hibiki.youtube-browse.v1",
    "hibiki.youtube-playlist-read.v1",
    "hibiki.advisory.v1",
    "hibiki.youtube-session.v1",
    "hibiki.plex-requested-downloads.v1",
    "hibiki.plex-maintenance.v1",
    "hibiki.plex-analysis.v1",
    "hibiki.client.v1",
    // Retire persisted work from the removed, experimental download backend.
    "hibiki.youtube-downloads.v1",
    "hibiki.youtube-downloads.v2",
    "hibiki.youtube-audio-probe.v1",
];
pub(super) fn definition(name: &'static str) -> butler::JobDef {
    if name == "hibiki.youtube-downloads.v1" {
        return butler::JobDef {
            name,
            ..retired::JOB
        };
    }
    butler::JobDef {
        name,
        ..execute::JOB
    }
}

#[butler::job(name = "hibiki.retired.v1", retries = 0)]
async fn retired(_payload: Value) -> Result<Value, Failure> {
    Ok(Value::Null)
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub(super) struct Failure {
    message: String,
    retry: bool,
}
impl butler::Retryable for Failure {
    fn retry(&self) -> butler::Retry {
        if self.retry {
            butler::Retry::Default
        } else {
            butler::Retry::Never
        }
    }
}

#[butler::job(name = "hibiki.background.v1", retries = 6, backoff = "exponential")]
pub(super) async fn execute(
    work: Work,
    progress: butler::Progress<super::progress::Progress>,
) -> Result<Value, Failure> {
    let app = APP.get().ok_or_else(|| Failure {
        message: "Hibiki background runtime is unavailable".into(),
        retry: true,
    })?;
    super::progress::run(app, work.id, progress, perform(app, work.task)).await
}

async fn perform(app: &tauri::AppHandle, task: Task) -> Result<Value, Failure> {
    let context = match &task {
        Task::PlexDownloads { context }
        | Task::PlexMatchingIndex { context }
        | Task::PlexAnalysis { context }
        | Task::PlexRequestedDownloads { context } => Some(context.clone()),
        _ => None,
    };
    let retry = matches!(task, Task::ListeningOutbox);
    let read = matches!(
        task,
        Task::YoutubeBrowse { .. } | Task::YoutubePlaylistRead { .. } | Task::YoutubeAudioProbe { .. }
    );
    let result = match task {
        Task::Client { request } => super::client::run(app, request).await,
        Task::Advisory { id, .. } => {
            use tauri::Manager;
            let work = app
                .state::<std::sync::Arc<super::BackgroundJobs>>()
                .advisory
                .lock()
                .ok()
                .and_then(|mut work| work.remove(&id));
            // Advisory work is cache warming/maintenance, not user intent. On
            // restart the original closure is gone; the next real read retries it.
            if let Some(work) = work {
                work.await;
            }
            Ok(Value::Null)
        }
        Task::PlexMaintenance => crate::matching_index::maintain(app)
            .await
            .map(|_| Value::Null),
        Task::PlexAnalysis { context } => {
            crate::offline_audio::run_analysis_backfill(app, &context)
                .await
                .map(|_| Value::Null)
        }
        Task::ListeningOutbox => crate::listening_history::drain(app)
            .await
            .map(|_| Value::Null),
        Task::YoutubeSessionMaintenance => crate::ytmusic::background_session(app)
            .await
            .map(|_| Value::Null),
        Task::PlexRequestedDownloads { context } => {
            crate::download_entities::refresh_requested(app, &context)
                .await
                .map(|_| Value::Null)
        }
        Task::PlexDownloads { context } => crate::offline_audio::run_download_worker(app, &context)
            .await
            .map(|_| Value::Null),
        Task::YoutubeDownloads { scope,generation } => crate::provider_downloads::run_youtube_download_worker(app,scope,generation)
            .await.map(|_|Value::Null),
        Task::PlexMatchingIndex { context } => {
            crate::matching_index::run_index_worker(app, &context)
                .await
                .map(|_| Value::Null)
        }
        Task::YoutubeBrowse { request } => crate::ytmusic::background_browse(app, request).await,
        Task::YoutubeAudioProbe { video_id, account, generation } => crate::ytmusic::background_audio_probe(app, video_id, account, generation).await,
        Task::YoutubePlaylistRead {
            playlist_id,
            account,
            generation,
            source_only,
        } => crate::ytmusic::background_playlist_read(app, playlist_id, account, generation, source_only).await,
    };
    if result.is_err() {
        if let Some(context) = context {
            use tauri::Manager;
            let state = app.state::<crate::commands::PlexState>();
            let client = state.0.lock().await;
            // Expected retirement after a reconnect is cancellation, not a
            // broken handler. Its original scoped journal remains intact.
            if state.checked_cache_client(&context, &client).is_err() {
                return Ok(Value::Null);
            }
        }
    }
    if read {
        if let Err(message) = &result {
            return Ok(serde_json::json!({ "_hibikiDeferred": message }));
        }
    }
    result.map_err(|message| Failure { message, retry })
}

pub(super) fn not_admitted(app: &tauri::AppHandle, task: &Task) {
    match task {
        Task::PlexDownloads { context } => {
            crate::offline_audio::retire_download_worker(app, context)
        }
        Task::PlexAnalysis { context } => {
            crate::offline_audio::retire_analysis_backfill(app, context)
        }
        Task::PlexMatchingIndex { context } => {
            crate::matching_index::retire_index_worker(app, context)
        }
        _ => {}
    }
}

/// Recurring timers discover due work; idle polls need no durable job, claim,
/// checkpoint or Activity event. Handlers still recheck before doing IO.
pub(super) async fn ready(app: &tauri::AppHandle, task: &Task) -> Result<bool, String> {
    match task {
        Task::YoutubeSessionMaintenance => Ok(crate::ytmusic::session_due(app)),
        Task::PlexMaintenance => crate::matching_index::maintenance_due(app).await,
        Task::ListeningOutbox => crate::listening_history::work_due(app).await,
        Task::PlexRequestedDownloads { context } => crate::download_entities::refresh_due(app, context).await,
        _ => Ok(true),
    }
}
