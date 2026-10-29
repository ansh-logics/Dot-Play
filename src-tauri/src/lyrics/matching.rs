//! Query cleanup and candidate matching used when searching lyrics providers.

pub(crate) fn clean_query_title(title: &str) -> String {
    let t = title.trim();
    let re_markers = [
        "(official video)",
        "(official audio)",
        "(official music video)",
        "[official video]",
        "[official audio]",
        "(audio)",
        "(lyrics)",
        "(lyric video)",
        "[lyric video]",
        "(visualizer)",
        "[visualizer]",
        "(clean version)",
        "(extended mix)",
        "(full video)",
        "(full song)",
    ];
    for marker in re_markers {
        if let Some(pos) = crate::ytmusic::parse::find_ascii_ci(t, marker) {
            return t[..pos].trim().to_string();
        }
    }
    t.to_string()
}

pub(crate) fn clean_query_artist(artist: &str) -> (String, String) {
    let base = artist
        .split('•')
        .next()
        .unwrap_or(artist)
        .split('|')
        .next()
        .unwrap_or(artist)
        .replace("- Topic", "")
        .trim()
        .to_string();
    let primary = base
        .split('&')
        .next()
        .unwrap_or(&base)
        .split(',')
        .next()
        .unwrap_or(&base)
        .split("feat.")
        .next()
        .unwrap_or(&base)
        .split("ft.")
        .next()
        .unwrap_or(&base)
        .trim()
        .to_string();
    (base, primary)
}

pub(super) fn urlencoding_lite(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match *b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            b' ' => out.push_str("%20"),
            byte => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn normalized_lyrics_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn lyric_version_markers(value: &str) -> Vec<&'static str> {
    const MARKERS: &[&str] = &[
        "live", "remix", "remixed", "acoustic", "unplugged", "instrumental", "karaoke",
        "cover", "sped", "slowed", "reverb", "nightcore", "extended", "remaster",
        "remastered", "demo", "edit",
    ];
    let lower = value.to_lowercase();
    MARKERS
        .iter()
        .copied()
        .filter(|marker| lower.contains(marker))
        .collect()
}

fn json_string<'a>(value: &'a serde_json::Value, names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|name| value.get(*name)?.as_str())
}

pub(super) fn json_seconds(value: &serde_json::Value) -> Option<f64> {
    value
        .get("duration")
        .or_else(|| value.get("durationSeconds"))
        .and_then(|duration| duration.as_f64().or_else(|| duration.as_str()?.parse().ok()))
}

fn is_matching_lyrics_candidate(
    candidate: &serde_json::Value,
    title: &str,
    artist: &str,
    duration_seconds: i64,
) -> bool {
    let Some(candidate_title) = json_string(candidate, &["track_name", "title", "trackName"]) else {
        return false;
    };
    let wanted_title = normalized_lyrics_key(title);
    let found_title = normalized_lyrics_key(candidate_title);
    if wanted_title.is_empty()
        || found_title.is_empty()
        || !(found_title == wanted_title
            || found_title.contains(&wanted_title)
            || wanted_title.contains(&found_title))
    {
        return false;
    }

    if lyric_version_markers(title) != lyric_version_markers(candidate_title) {
        return false;
    }

    if let Some(candidate_artist) = json_string(candidate, &["artist_name", "artist", "artistName"]) {
        let wanted_artist = normalized_lyrics_key(artist);
        let found_artist = normalized_lyrics_key(candidate_artist);
        if !wanted_artist.is_empty()
            && !found_artist.is_empty()
            && !found_artist.contains(&wanted_artist)
            && !wanted_artist.contains(&found_artist)
        {
            return false;
        }
    }

    if duration_seconds > 0 {
        if let Some(candidate_duration) = json_seconds(candidate) {
            if (candidate_duration - duration_seconds as f64).abs() > 6.0 {
                return false;
            }
        }
    }

    true
}

pub(super) fn best_lyrics_candidate<'a>(
    candidates: &'a [serde_json::Value],
    title: &str,
    artist: &str,
    duration_seconds: i64,
) -> Option<&'a serde_json::Value> {
    candidates
        .iter()
        .filter(|candidate| is_matching_lyrics_candidate(candidate, title, artist, duration_seconds))
        .min_by(|left, right| {
            let left_distance = json_seconds(left)
                .map(|duration| (duration - duration_seconds as f64).abs())
                .unwrap_or(f64::MAX);
            let right_distance = json_seconds(right)
                .map(|duration| (duration - duration_seconds as f64).abs())
                .unwrap_or(f64::MAX);
            left_distance.total_cmp(&right_distance)
        })
}
