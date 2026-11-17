//! Downloads and archives for the data viewer. Files live under the app data directory and
//! are addressed from the web side by a relative name, so the web code never sees full paths.

use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_http::reqwest;

/// Downloads are limited to the hosts the app gets data from.
const HOSTS: &[&str] = &["ftp.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "pmc-oa-opendata.s3.amazonaws.com"];
/// Larger files are refused: they would not fit comfortably on a phone, and none could be
/// opened as a table anyway.
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The absolute path of a name inside app data. Absolute names and `..` are refused.
fn resolve(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let relative = Path::new(name);
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("not a valid file name: {name}"));
    }
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join(relative))
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    id: &'a str,
    received: u64,
    total: Option<u64>,
}

/// Streams a file to app data, reporting progress as `download-progress` events tagged with
/// `id`. Writes to a temporary name first, so an interrupted download never looks complete.
/// Returns the number of bytes written.
#[tauri::command]
pub async fn download_file(app: AppHandle, url: String, name: String, id: String) -> Result<u64, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" || !HOSTS.contains(&parsed.host_str().unwrap_or("")) {
        return Err(format!("downloads from {} are not allowed", parsed.host_str().unwrap_or("?")));
    }
    let dest = resolve(&app, &name)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let partial = dest.with_extension("partial");

    let mut response = reqwest::get(parsed).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("the server answered {}", response.status()));
    }
    let total = response.content_length();
    if total.is_some_and(|t| t > MAX_BYTES) {
        return Err("This file is over 2 GB, too large to download to a phone.".into());
    }

    let mut out = File::create(&partial).map_err(|e| e.to_string())?;
    let mut received = 0u64;
    let mut reported = 0u64;
    let result = async {
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            if received > MAX_BYTES {
                return Err("This file is over 2 GB, too large to download to a phone.".to_string());
            }
            if received - reported >= 256 * 1024 {
                reported = received;
                let _ = app.emit("download-progress", Progress { id: &id, received, total });
            }
        }
        out.flush().map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = result {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    fs::rename(&partial, &dest).map_err(|e| e.to_string())?;
    let _ = app.emit("download-progress", Progress { id: &id, received, total: Some(received) });
    Ok(received)
}

/// Removes a downloaded file, or a directory of extracted files.
#[tauri::command]
pub fn remove_stored(app: AppHandle, name: String) -> Result<(), String> {
    let path = resolve(&app, &name)?;
    let result = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
    match result {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    size: u64,
}

fn open_tar(path: &Path) -> io::Result<tar::Archive<Box<dyn Read>>> {
    let file = BufReader::new(File::open(path)?);
    let gz = path.extension().is_some_and(|e| e == "gz" || e == "tgz");
    let reader: Box<dyn Read> = if gz { Box::new(GzDecoder::new(file)) } else { Box::new(file) };
    Ok(tar::Archive::new(reader))
}

/// The regular files in a tar archive (optionally gzipped).
#[tauri::command(async)]
pub fn tar_list(app: AppHandle, name: String) -> Result<Vec<Entry>, String> {
    let mut archive = open_tar(&resolve(&app, &name)?).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.header().entry_type().is_file() {
            let path = entry.path().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
            entries.push(Entry { name: path, size: entry.size() });
        }
    }
    Ok(entries)
}

/// Extracts the named entries into directory `into` (flattened to their file names) and
/// returns the relative names of the extracted files, in archive order.
#[tauri::command(async)]
pub fn tar_extract(app: AppHandle, name: String, entries: Vec<String>, into: String) -> Result<Vec<String>, String> {
    let dir = resolve(&app, &into)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut archive = open_tar(&resolve(&app, &name)?).map_err(|e| e.to_string())?;
    let mut written = Vec::new();
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
        if !entries.contains(&path) {
            continue;
        }
        let file_name = Path::new(&path).file_name().ok_or("entry without a file name")?.to_string_lossy().into_owned();
        let mut out = File::create(dir.join(&file_name)).map_err(|e| e.to_string())?;
        io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        written.push(format!("{into}/{file_name}"));
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tar_round_trip() {
        let dir = std::env::temp_dir().join(format!("corpus-tar-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let tar_path = dir.join("x.tar");
        {
            let mut builder = tar::Builder::new(File::create(&tar_path).unwrap());
            for (name, body) in [("GSM1_a.txt", "g\t1\n"), ("sub/GSM2_b.txt", "g\t2\n")] {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, body.as_bytes()).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut archive = open_tar(&tar_path).unwrap();
        let names: Vec<String> = archive.entries().unwrap().map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["GSM1_a.txt", "sub/GSM2_b.txt"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
