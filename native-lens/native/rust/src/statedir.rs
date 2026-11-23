//! Port of `lib/statedir.cjs` without a session id: where the repository statistics cache of a folder lives.
//! Read-only: pin files and pruning are not part of the slice.

use crate::jspath::{basename, dirname, env_nonempty, homedir, is_absolute, join, relative, resolve};
use crate::sha1;

const MARKERS: [&str; 8] = [".git", "package.json", "token-guard.config.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
const USER_FOLDERS: [&str; 7] = ["desktop", "documents", "downloads", "pictures", "videos", "music", "onedrive"];
const SYSTEM_SEGMENTS: [&str; 7] = ["appdata", "node_modules", "windows", "program files", "program files (x86)", "programdata", "system32"];
const SYSTEM_LEAVES: [&str; 5] = ["bin", "sbin", "etc", "usr", "var"];

/// Per-user data folder on Windows.
fn data_home() -> String {
    let base = env_nonempty("LOCALAPPDATA").unwrap_or_else(|| join(&[&homedir(), "AppData", "Local"]));
    join(&[&base, "token-guard"])
}

fn same_dir(a: &str, b: &str) -> bool {
    resolve(&[a]).to_lowercase() == resolve(&[b]).to_lowercase()
}

/// True when the folder can never be a project root (home, personal folder, system area, drive root).
fn never_project(dir: &str) -> bool {
    let abs = resolve(&[dir]);
    if dirname(&abs) == abs {
        return true;
    }
    let home = homedir();
    if same_dir(&abs, &home) {
        return true;
    }
    if same_dir(&dirname(&abs), &home) && USER_FOLDERS.contains(&basename(&abs).to_lowercase().as_str()) {
        return true;
    }
    let rel = relative(&home, &abs);
    let in_home = !rel.is_empty() && !rel.starts_with("..") && !is_absolute(&rel);
    if SYSTEM_LEAVES.contains(&basename(&abs).to_lowercase().as_str()) {
        return true;
    }
    let source = if in_home { &rel } else { &abs };
    let segments: Vec<String> = source.split(['\\', '/']).map(str::to_lowercase).collect();
    let temp_at = (0..segments.len()).find(|&i| {
        segments[i] == "appdata" && segments.get(i + 1).is_some_and(|s| s == "local") && segments.get(i + 2).is_some_and(|s| s == "temp")
    });
    let scan = match temp_at {
        Some(i) => &segments[(i + 3).min(segments.len())..],
        None => &segments[..],
    };
    scan.iter().any(|s| SYSTEM_SEGMENTS.contains(&s.as_str()))
}

/// First ancestor of `dir` that carries a project marker.
fn project_root(dir: &str) -> Option<String> {
    let mut cur = resolve(&[dir]);
    loop {
        if never_project(&cur) {
            return None;
        }
        if MARKERS.iter().any(|m| std::path::Path::new(&join(&[&cur, m])).exists()) {
            return Some(cur);
        }
        let up = dirname(&cur);
        if up == cur {
            return None;
        }
        cur = up;
    }
}

/// `stateDir(root)`: `<project>/.token-guard`, or the per-user state folder keyed by the lower-cased path.
pub fn state_dir(root: &str) -> String {
    let origin = resolve(&[root]);
    match project_root(&origin) {
        Some(project) => join(&[&project, ".token-guard"]),
        None => {
            let key = sha1::hex(origin.to_lowercase().as_bytes());
            join(&[&data_home(), "state", &key[..16]])
        }
    }
}
