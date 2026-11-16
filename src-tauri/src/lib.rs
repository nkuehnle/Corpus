use std::io;
use std::str::FromStr;

use corpus_analytics::{Matrix, Transform};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
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

/// What the data viewer asks for.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Analysis {
    #[serde(rename_all = "camelCase")]
    De { rows: usize, cols: usize, transform: String, group_a: Vec<usize>, group_b: Vec<usize> },
    #[serde(rename_all = "camelCase")]
    Pca { rows: usize, cols: usize, transform: String, samples: Vec<usize>, top: usize },
}

/// A result matrix, row-major, with whatever else the analysis reports.
#[derive(Serialize)]
struct AnalysisResult {
    rows: usize,
    cols: usize,
    values: Vec<f64>,
    explained: Vec<f64>,
    genes: usize,
}

/// Runs a built-in analysis on a table from the data viewer.
///
/// `data` is the matrix as base64 of little-endian f32 values. Android's WebView can only pass
/// JSON to Rust, and a count matrix is millions of numbers: base64 of single-precision floats
/// is about a seventh the size of the same numbers written out as a JSON array.
#[tauri::command(async)]
fn analyze(request: Analysis, data: String) -> Result<AnalysisResult, String> {
    let bytes = BASE64.decode(data).map_err(|e| format!("malformed matrix: {e}"))?;
    let values: Vec<f64> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap()) as f64).collect();
    match request {
        Analysis::De { rows, cols, transform, group_a, group_b } => {
            let matrix = Matrix::new(&values, rows, cols)?;
            let result = corpus_analytics::differential_expression(&matrix, &group_a, &group_b, Transform::parse(&transform)?)?;
            let flat = result.iter().flat_map(|r| [r.row as f64, r.mean_a, r.mean_b, r.log2_fc, r.t, r.p, r.p_adj]).collect();
            Ok(AnalysisResult { rows: result.len(), cols: 7, values: flat, explained: vec![], genes: result.len() })
        }
        Analysis::Pca { rows, cols, transform, samples, top } => {
            let matrix = Matrix::new(&values, rows, cols)?;
            let result = corpus_analytics::pca(&matrix, &samples, Transform::parse(&transform)?, top, 5)?;
            Ok(AnalysisResult {
                rows: samples.len(),
                cols: result.explained.len(),
                values: result.scores.into_iter().flatten().collect(),
                explained: result.explained,
                genes: result.genes,
            })
        }
    }
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
        .invoke_handler(tauri::generate_handler![copy_any, analyze])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
