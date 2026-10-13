//! Provider-independent reviewed identity evidence; never includes credentials.
use serde::Serialize;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alias {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct Credit {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mbid: Option<String>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identifiers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_mbid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_group_mbid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wikidata_qid: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub provider: String,
    pub kind: String,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub aliases: Vec<Alias>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disambiguation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    pub artist_credits: Vec<Credit>,
    pub identifiers: Identifiers,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub candidate: Candidate,
    pub fields: serde_json::Value,
    pub field_origins: std::collections::BTreeMap<String, String>,
    pub reviewed_at: u64,
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
pub fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id.to_lowercase())
}
pub fn bounded_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 512).then(|| value.to_owned())
}
pub fn wikidata_qid(url: &str) -> Option<String> {
    let url = url::Url::parse(url).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.wikidata.org")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let qid = url.path().strip_prefix("/wiki/")?;
    valid_qid(qid).then(|| qid.to_owned())
}
pub fn valid_qid(id: &str) -> bool {
    id.len() <= 20
        && id.starts_with('Q')
        && id
            .as_bytes()
            .get(1)
            .is_some_and(|c| *c >= b'1' && *c <= b'9')
        && id[1..].bytes().all(|c| c.is_ascii_digit())
}
