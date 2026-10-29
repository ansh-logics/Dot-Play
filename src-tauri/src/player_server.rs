//! Local HTTP server that serves the embedded YouTube player bridge page.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use tauri::State;

pub struct PlayerServerState(pub u16);

pub(crate) fn start_player_server() -> u16 {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[DOT Music] Failed to bind local player server: {}", e);
            return 0;
        }
    };

    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            eprintln!("[DOT Music] Failed to get local player server port: {}", e);
            return 0;
        }
    };

    println!("[DOT Music] Local YouTube player server listening on http://127.0.0.1:{}", port);

    thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                thread::spawn(move || {
                    let mut buffer = [0u8; 2048];
                    let _ = stream.read(&mut buffer);
                    let req = String::from_utf8_lossy(&buffer);

                    if req.starts_with("OPTIONS") {
                        let response = "HTTP/1.1 204 No Content\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Access-Control-Allow-Methods: GET, OPTIONS\r\n\
                            Access-Control-Allow-Headers: *\r\n\
                            Connection: close\r\n\r\n";
                        let _ = stream.write_all(response.as_bytes());
                    } else if req.starts_with("GET /favicon.ico") {
                        let response = "HTTP/1.1 404 Not Found\r\n\
                            Connection: close\r\n\r\n";
                        let _ = stream.write_all(response.as_bytes());
                    } else {
                        let html = include_str!("../resources/player-bridge.html");
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Referrer-Policy: strict-origin-when-cross-origin\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            html.len(),
                            html
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    let _ = stream.flush();
                });
            }
        }
    });

    port
}

#[tauri::command]
pub(crate) fn get_player_server_url(state: State<PlayerServerState>) -> Option<String> {
    if state.0 > 0 {
        Some(format!("http://127.0.0.1:{}/player.html", state.0))
    } else {
        None
    }
}
