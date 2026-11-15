use std::io;
use std::str::FromStr;

use tauri::AppHandle;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// Copies a file. Either end may be a plain path or, on Android, a `content://`
/// URI handed back by the file picker, which only the fs plugin can open.
#[tauri::command]
async fn copy_any(app: AppHandle, src: String, dest: String) -> Result<u64, String> {
    let copy = || -> io::Result<u64> {
        let mut read = OpenOptions::new();
        read.read(true);
        let mut input = app.fs().open(parse(&src)?, read)?;

        let mut write = OpenOptions::new();
        write.write(true).create(true).truncate(true);
        let mut output = app.fs().open(parse(&dest)?, write)?;

        io::copy(&mut input, &mut output)
    };
    copy().map_err(|e| format!("copy {src} -> {dest}: {e}"))
}

fn parse(location: &str) -> io::Result<FilePath> {
    FilePath::from_str(location).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![copy_any])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
