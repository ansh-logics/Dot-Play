//! Linked TVs, from the desktop's side.
//!
//! Finds dot(.)play TVs on the local network (mDNS), links to one with the code it shows
//! (`link::client`), and from then on keeps a connection to every linked TV that is on, so a
//! sign-in or sign-out here reaches them at once. Links live in the private `tv_links.json`.

use crate::link::client::{self, ConnectError, Session};
use crate::link::{self, LinkRecord, Peer};
use crate::session::SessionState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

/// How often a linked TV that isn't connected is tried again.
const RETRY_EVERY: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedTv {
    #[serde(flatten)]
    link: LinkRecord,
    /// Where it last answered, tried when the network search hasn't found it (yet).
    #[serde(default)]
    last_addr: Option<SocketAddr>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default)]
    id: String,
    #[serde(default)]
    tvs: Vec<SavedTv>,
}

#[derive(Clone)]
struct Found {
    id: Option<String>,
    name: String,
    addr: SocketAddr,
}

#[derive(Default)]
struct Inner {
    id: String,
    tvs: Vec<SavedTv>,
    /// Open connections, by TV id: the way to send that TV a message.
    sessions: HashMap<String, mpsc::UnboundedSender<Value>>,
    connecting: HashSet<String>,
    /// TVs the network search currently sees, by their full service name.
    found: HashMap<String, Found>,
}

#[derive(Default)]
pub struct TvHub {
    inner: Mutex<Inner>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedTv {
    id: String,
    name: String,
    online: bool,
    linked_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyTv {
    /// What to pass to `pair_tv`.
    address: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TvStatus {
    linked: Vec<LinkedTv>,
    /// TVs on this network that aren't linked yet.
    nearby: Vec<NearbyTv>,
}

fn saved_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("tv_links.json"))
}

fn persist(app: &AppHandle, inner: &Inner) {
    let Some(path) = saved_path(app) else { return };
    let saved = Saved { id: inner.id.clone(), tvs: inner.tvs.clone() };
    if let Ok(data) = serde_json::to_vec(&saved) {
        // Private: these secrets let this computer hand a TV its session.
        if let Err(error) = crate::fsutil::write_atomic(&path, &data, true) {
            log::warn!("Saving linked TVs failed: {error}");
        }
    }
}

fn status_of(inner: &Inner) -> TvStatus {
    let linked_ids: HashSet<&str> = inner.tvs.iter().map(|tv| tv.link.id.as_str()).collect();
    let mut nearby: Vec<NearbyTv> = inner
        .found
        .values()
        .filter(|tv| tv.id.as_deref().is_none_or(|id| !linked_ids.contains(id)))
        .map(|tv| NearbyTv { address: tv.addr.to_string(), name: tv.name.clone() })
        .collect();
    nearby.sort_by(|a, b| a.name.cmp(&b.name).then(a.address.cmp(&b.address)));
    nearby.dedup_by(|a, b| a.address == b.address);
    TvStatus {
        linked: inner
            .tvs
            .iter()
            .map(|tv| LinkedTv {
                id: tv.link.id.clone(),
                name: tv.link.name.clone(),
                online: inner.sessions.contains_key(&tv.link.id),
                linked_at: tv.link.linked_at,
            })
            .collect(),
        nearby,
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit("tvs-changed", ());
}

/// This computer's name, as the TV shows it.
fn computer_name() -> String {
    let command = if cfg!(target_os = "macos") { ("scutil", vec!["--get", "ComputerName"]) } else { ("hostname", vec![]) };
    std::process::Command::new(command.0)
        .args(command.1)
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Computer".to_string())
}

fn cookies(app: &AppHandle) -> Option<String> {
    app.state::<SessionState>().cookies.lock().unwrap().clone()
}

pub fn init(app: &AppHandle) {
    let saved: Saved = saved_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    {
        let hub = app.state::<TvHub>();
        let mut inner = hub.inner.lock().unwrap();
        inner.id = if saved.id.is_empty() { link::random_id() } else { saved.id };
        inner.tvs = saved.tvs;
    }
    search_network(app.clone());

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(RETRY_EVERY);
        loop {
            tick.tick().await;
            let offline: Vec<(String, SocketAddr)> = {
                let hub = app.state::<TvHub>();
                let inner = hub.inner.lock().unwrap();
                inner
                    .tvs
                    .iter()
                    .filter(|tv| !inner.sessions.contains_key(&tv.link.id))
                    .filter_map(|tv| {
                        let seen = inner.found.values().find(|f| f.id.as_deref() == Some(&tv.link.id)).map(|f| f.addr);
                        seen.or(tv.last_addr).map(|addr| (tv.link.id.clone(), addr))
                    })
                    .collect()
            };
            for (id, addr) in offline {
                connect(&app, id, addr);
            }
        }
    });
}

/// A TV the network search sees: remember it, and reconnect if it is one of ours.
fn tv_seen(app: &AppHandle, key: String, found: Found) {
    let linked = {
        let hub = app.state::<TvHub>();
        let mut inner = hub.inner.lock().unwrap();
        let id = found.id.clone().filter(|id| inner.tvs.iter().any(|tv| &tv.link.id == id));
        let addr = found.addr;
        inner.found.insert(key, found);
        id.map(|id| (id, addr))
    };
    if let Some((id, addr)) = linked {
        connect(app, id, addr);
    }
    changed(app);
}

/// The instance names in `dns-sd -B` output that are still there at the end of it. Lines look
/// like `18:23:46.556  Add  2  11 local.  _dotplay._tcp.  Living Room TV`.
#[cfg(any(target_os = "macos", test))]
fn browse_names(listing: &str, service: &str) -> HashSet<String> {
    let marker = format!("{service}.");
    let mut present = HashSet::new();
    for line in listing.lines() {
        let Some(action) = line.split_whitespace().nth(1) else { continue };
        let Some(at) = line.find(&marker) else { continue };
        let name = line[at + marker.len()..].trim().to_string();
        if name.is_empty() {
            continue;
        }
        match action {
            "Add" => {
                present.insert(name);
            }
            "Rmv" => {
                present.remove(&name);
            }
            _ => {}
        }
    }
    present
}

/// Host, port and the TV's id from `dns-sd -L` output:
/// `... can be reached at Android.local.:47873 (interface 11)` followed by ` id=...`.
#[cfg(any(target_os = "macos", test))]
fn resolved_service(details: &str) -> Option<(String, u16, Option<String>)> {
    let target = details.split("can be reached at ").nth(1)?.split_whitespace().next()?;
    let (host, port) = target.rsplit_once(':')?;
    let id = details.split_whitespace().find_map(|field| field.strip_prefix("id=")).map(str::to_string);
    Some((host.to_string(), port.parse().ok()?, id))
}

/// Watches the local network for TVs for as long as the app runs.
///
/// On macOS this asks the system's Bonjour (`dns-sd`), in short self-ending runs: a socket of
/// our own on the mDNS port doesn't get the replies there, the system's resolver does.
#[cfg(target_os = "macos")]
fn search_network(app: AppHandle) {
    use std::net::ToSocketAddrs;
    use std::process::Command;

    /// Runs `dns-sd` for two seconds. The shell ends it even if this app is gone by then.
    fn dns_sd(args: &[&str]) -> String {
        let script = r#"/usr/bin/dns-sd "$@" & pid=$!; sleep 2; kill $pid 2>/dev/null"#;
        Command::new("/bin/sh")
            .args(["-c", script, "dns-sd"])
            .args(args)
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default()
    }

    let service = link::SERVICE_TYPE.trim_end_matches("local.").trim_end_matches('.').to_string();
    std::thread::spawn(move || loop {
        let present = browse_names(&dns_sd(&["-B", &service, "local."]), &service);

        for name in &present {
            if app.state::<TvHub>().inner.lock().unwrap().found.contains_key(name) {
                continue;
            }
            let Some((host, port, id)) = resolved_service(&dns_sd(&["-L", name, &service, "local."])) else { continue };
            // IPv4 first: link-local IPv6 needs a scope the address alone doesn't carry.
            let Some(addr) = (host.as_str(), port).to_socket_addrs().ok().and_then(|mut addrs| addrs.find(SocketAddr::is_ipv4)) else {
                continue;
            };
            tv_seen(&app, name.clone(), Found { id, name: name.clone(), addr });
        }

        let gone = {
            let hub = app.state::<TvHub>();
            let mut inner = hub.inner.lock().unwrap();
            let before = inner.found.len();
            inner.found.retain(|name, _| present.contains(name));
            inner.found.len() != before
        };
        if gone {
            changed(&app);
        }
        std::thread::sleep(Duration::from_secs(8));
    });
}

#[cfg(not(target_os = "macos"))]
fn search_network(app: AppHandle) {
    std::thread::spawn(move || {
        let daemon = match mdns_sd::ServiceDaemon::new() {
            Ok(daemon) => daemon,
            Err(error) => {
                log::warn!("Can't search the network for TVs: {error}");
                return;
            }
        };
        let Ok(events) = daemon.browse(link::SERVICE_TYPE) else { return };
        while let Ok(event) = events.recv() {
            match event {
                mdns_sd::ServiceEvent::ServiceResolved(info) => {
                    // IPv4 first: link-local IPv6 needs a scope the address alone doesn't carry.
                    let Some(ip) = info.get_addresses_v4().into_iter().next() else { continue };
                    let addr = SocketAddr::new(IpAddr::V4(ip), info.port);
                    let name = info.fullname.strip_suffix(&format!(".{}", link::SERVICE_TYPE)).unwrap_or(&info.fullname).replace('\\', "");
                    let id = info.get_property_val_str("id").map(str::to_string);
                    tv_seen(&app, info.fullname.clone(), Found { id, name, addr });
                }
                mdns_sd::ServiceEvent::ServiceRemoved(_, fullname) => {
                    app.state::<TvHub>().inner.lock().unwrap().found.remove(&fullname);
                    changed(&app);
                }
                _ => {}
            }
        }
    });
}

/// Reconnects to a linked TV, unless a connection is already open or on its way.
fn connect(app: &AppHandle, id: String, addr: SocketAddr) {
    let (my_id, link) = {
        let hub = app.state::<TvHub>();
        let mut inner = hub.inner.lock().unwrap();
        if inner.sessions.contains_key(&id) || inner.connecting.contains(&id) {
            return;
        }
        let Some(tv) = inner.tvs.iter().find(|tv| tv.link.id == id) else { return };
        let link = tv.link.clone();
        inner.connecting.insert(id.clone());
        (inner.id.clone(), link)
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = client::resume(addr, &my_id, &link).await;
        app.state::<TvHub>().inner.lock().unwrap().connecting.remove(&id);
        match result {
            Ok(session) => serve(&app, id, addr, session),
            // Signed out on the TV: the link is gone on its side, so drop ours too.
            Err(ConnectError::Unknown) => {
                let hub = app.state::<TvHub>();
                let mut inner = hub.inner.lock().unwrap();
                inner.tvs.retain(|tv| tv.link.id != id);
                persist(&app, &inner);
                drop(inner);
                changed(&app);
            }
            Err(_) => {}
        }
    });
}

/// Keeps an open connection: remembers how to reach it, sends it the current session, and
/// passes on what the TV says until the connection ends.
fn serve(app: &AppHandle, id: String, addr: SocketAddr, mut session: Session) {
    let (send, mut outgoing) = mpsc::unbounded_channel::<Value>();
    {
        let hub = app.state::<TvHub>();
        let mut inner = hub.inner.lock().unwrap();
        inner.sessions.insert(id.clone(), send);
        if let Some(tv) = inner.tvs.iter_mut().find(|tv| tv.link.id == id) {
            tv.last_addr = Some(addr);
        }
        persist(app, &inner);
    }
    session.send(json!({ "t": "session", "cookies": cookies(app) }));
    changed(app);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                message = session.recv() => {
                    let Some(message) = message else { break };
                    let _ = app.emit_to("main", "tv-message", json!({ "id": id, "message": message }));
                }
                message = outgoing.recv() => {
                    // The hub dropped its sender: the TV was forgotten.
                    let Some(message) = message else { break };
                    session.send(message);
                }
            }
        }
        // Only clear the entry if it is still this connection's.
        let hub = app.state::<TvHub>();
        let mut inner = hub.inner.lock().unwrap();
        if inner.sessions.get(&id).is_some_and(|sender| sender.is_closed()) {
            inner.sessions.remove(&id);
        }
        drop(inner);
        changed(&app);
    });
}

/// Tells every connected TV who is signed in now (after a sign-in or sign-out here).
pub fn push_session(app: &AppHandle) {
    let Some(hub) = app.try_state::<TvHub>() else { return };
    let message = json!({ "t": "session", "cookies": cookies(app) });
    for sender in hub.inner.lock().unwrap().sessions.values() {
        let _ = sender.send(message.clone());
    }
}

#[tauri::command]
pub fn get_tvs(hub: State<'_, TvHub>) -> TvStatus {
    status_of(&hub.inner.lock().unwrap())
}

/// Links the TV at `address` (from `get_tvs`, or an IP address typed by hand) using the code
/// on its screen.
#[tauri::command]
pub async fn pair_tv(app: AppHandle, address: String, code: String) -> Result<TvStatus, String> {
    let code: String = code.chars().filter(char::is_ascii_digit).collect();
    if code.len() != 6 {
        return Err("Enter the six-digit code shown on the TV.".into());
    }
    let address = address.trim();
    let addr: SocketAddr = address
        .parse()
        .or_else(|_| address.parse::<IpAddr>().map(|ip| SocketAddr::new(ip, link::PORT)))
        .map_err(|_| "That doesn't look like a TV's address.".to_string())?;
    let me = Peer { id: app.state::<TvHub>().inner.lock().unwrap().id.clone(), name: computer_name() };

    let (link, session) = client::pair(addr, &me, &code, cookies(&app)).await.map_err(|error| error.to_string())?;
    let id = link.id.clone();
    {
        let hub = app.state::<TvHub>();
        let mut inner = hub.inner.lock().unwrap();
        inner.tvs.retain(|tv| tv.link.id != id);
        // Dropping an older connection's sender closes it.
        inner.sessions.remove(&id);
        inner.tvs.push(SavedTv { link, last_addr: Some(addr) });
        persist(&app, &inner);
    }
    serve(&app, id, addr, session);
    let hub = app.state::<TvHub>();
    let status = status_of(&hub.inner.lock().unwrap());
    Ok(status)
}

/// Sends a playback message to a connected TV.
#[tauri::command]
pub fn send_to_tv(hub: State<'_, TvHub>, id: String, message: Value) -> Result<(), String> {
    let inner = hub.inner.lock().unwrap();
    let sender = inner.sessions.get(&id).ok_or("That TV isn't connected.")?;
    sender.send(message).map_err(|_| "That TV isn't connected.".to_string())
}

/// Unlinks a TV. If it is on, it is told, and signs out when this was its last computer.
#[tauri::command]
pub fn forget_tv(app: AppHandle, hub: State<'_, TvHub>, id: String) -> TvStatus {
    let mut inner = hub.inner.lock().unwrap();
    if let Some(sender) = inner.sessions.remove(&id) {
        let _ = sender.send(json!({ "t": "unlink" }));
    }
    inner.tvs.retain(|tv| tv.link.id != id);
    persist(&app, &inner);
    status_of(&inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_tvs_out_of_a_bonjour_listing() {
        let listing = "Browsing for _dotplay._tcp.local.\n\
            DATE: ---Sun 15 Nov 2026---\n\
            18:23:46.000  ...STARTING...\n\
            Timestamp     A/R    Flags  if Domain               Service Type         Instance Name\n\
            18:23:46.556  Add        3  11 local.               _dotplay._tcp.       Living Room TV\n\
            18:23:46.557  Add        2  11 local.               _dotplay._tcp.       Bedroom\n\
            18:23:47.100  Rmv        0  11 local.               _dotplay._tcp.       Bedroom\n";
        let names = browse_names(listing, "_dotplay._tcp");
        assert_eq!(names, HashSet::from(["Living Room TV".to_string()]));
    }

    #[test]
    fn reads_where_a_tv_is_and_which_one_it_is() {
        let details = "Lookup Living Room TV._dotplay._tcp.local.\n\
            18:23:50.411  Living\\032Room\\032TV._dotplay._tcp.local. can be reached at Android.local.:47873 (interface 11)\n \
            id=41c5a2cc2c2a441181b5a02eeea79c50\n";
        assert_eq!(
            resolved_service(details),
            Some(("Android.local.".to_string(), 47873, Some("41c5a2cc2c2a441181b5a02eeea79c50".to_string())))
        );
        assert_eq!(resolved_service("Lookup nothing\n"), None);
    }
}
