//! Everything Chunkwise does with files on disk. Kept free of Tauri so it can be tested on its own.
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub type Res<T> = Result<T, String>;
fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

fn mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The text of a file, or None when it isn't there.
pub fn read_text(path: &str) -> Res<Option<String>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(x) if x.kind() == ErrorKind::NotFound => Ok(None),
        Err(x) => Err(e(x)),
    }
}

/// Writes a file whole or not at all: to a temporary file next to it, then moved into place, so a crash never leaves half a plan.
pub fn write_text(path: &str, text: &str) -> Res<()> {
    write_atomic(Path::new(path), text.as_bytes())
}

fn write_atomic(p: &Path, bytes: &[u8]) -> Res<()> {
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(e)?;
    }
    let mut tmp = p.as_os_str().to_owned();
    tmp.push(".saving");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).map_err(e)?;
    fs::rename(&tmp, p).map_err(|x| {
        let _ = fs::remove_file(&tmp);
        e(x)
    })
}

/// Writes bytes (sent as base64). With `replace`, a file already there goes to the Recycle Bin first.
pub fn write_bytes(path: &str, b64: &str, replace: bool) -> Res<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(e)?;
    let p = Path::new(path);
    if p.exists() {
        if !replace {
            return Err("exists".into());
        }
        if trash::delete(p).is_err() {
            fs::remove_file(p).map_err(e)?;
        }
    }
    write_atomic(p, &bytes)?;
    Ok(path.to_string())
}

/// Removes a file, to the Recycle Bin unless told otherwise.
pub fn remove(path: &str, to_trash: bool) -> Res<()> {
    let p = Path::new(path);
    if !p.exists() {
        return Ok(());
    }
    if to_trash && trash::delete(p).is_ok() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(e)
    } else {
        fs::remove_file(p).map_err(e)
    }
}

pub fn rename(from: &str, to: &str) -> Res<()> {
    if Path::new(to).exists() {
        return Err("exists".into());
    }
    if let Some(dir) = Path::new(to).parent() {
        fs::create_dir_all(dir).map_err(e)?;
    }
    fs::rename(from, to).map_err(e)
}

pub fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub mtime: u64,
}

/// The files in a folder ending in `ext` (empty: all files), newest first.
pub fn list_dir(dir: &str, ext: &str) -> Res<Vec<Entry>> {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(x) if x.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(x) => return Err(e(x)),
    };
    let mut out: Vec<Entry> = rd
        .filter_map(|d| d.ok())
        .filter(|d| d.path().is_file())
        .filter_map(|d| {
            let name = d.file_name().to_string_lossy().to_string();
            if !ext.is_empty() && !name.to_lowercase().ends_with(&ext.to_lowercase()) {
                return None;
            }
            let p = d.path();
            Some(Entry { mtime: mtime_ms(&p), path: p.to_string_lossy().to_string(), name })
        })
        .collect();
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

#[derive(Serialize, Debug)]
pub struct PlanInfo {
    pub path: String,
    pub id: String,
    pub meta: serde_json::Value,
    pub sync: bool,
    pub mtime: u64,
}

/// Every plan file in the plans folder: its id, its record (name, floors, buildings…) and whether it syncs. The floors stay on disk.
pub fn list_plans(dir: &str) -> Res<Vec<PlanInfo>> {
    let mut out = vec![];
    for f in list_dir(dir, ".chunkwise")? {
        let Ok(text) = fs::read_to_string(&f.path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(id) = v.get("id").and_then(|x| x.as_str()) else { continue };
        out.push(PlanInfo {
            id: id.to_string(),
            meta: v.get("meta").cloned().unwrap_or(serde_json::Value::Null),
            sync: v.get("sync").and_then(|x| x.as_bool()).unwrap_or(false),
            path: f.path,
            mtime: f.mtime,
        });
    }
    Ok(out)
}

#[derive(Serialize, Debug, Clone)]
pub struct Instance {
    pub name: String,
    pub launcher: String,
    /// the game folder: the one holding mods, config, saves
    pub path: String,
}

fn read_cfg_name(file: &Path) -> Option<String> {
    let t = fs::read_to_string(file).ok()?;
    t.lines().find_map(|l| l.strip_prefix("name=").map(|s| s.trim().to_string())).filter(|s| !s.is_empty())
}

fn read_json_name(file: &Path, keys: &[&str]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(file).ok()?).ok()?;
    keys.iter().find_map(|k| v.get(*k).and_then(|x| x.as_str()).map(String::from))
}

fn subdirs(p: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(p).map(|r| r.filter_map(|d| d.ok()).map(|d| d.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
    v.sort();
    v
}

/// Minecraft game folders on this computer: the official launcher's, and each instance of Prism, MultiMC, CurseForge, Modrinth and ATLauncher.
/// `roaming` is AppData\Roaming, `home` the user folder.
pub fn find_instances(roaming: &Path, home: &Path) -> Vec<Instance> {
    let mut out = vec![];
    let mut push = |name: String, launcher: &str, path: PathBuf| {
        if path.is_dir() {
            out.push(Instance { name, launcher: launcher.into(), path: path.to_string_lossy().to_string() });
        }
    };
    push("Minecraft".into(), "Minecraft Launcher", roaming.join(".minecraft"));
    for (launcher, base) in [("Prism Launcher", roaming.join("PrismLauncher").join("instances")), ("MultiMC", home.join("MultiMC").join("instances"))] {
        for inst in subdirs(&base) {
            let game = if inst.join(".minecraft").is_dir() { inst.join(".minecraft") } else { inst.join("minecraft") };
            let name = read_cfg_name(&inst.join("instance.cfg")).unwrap_or_else(|| inst.file_name().unwrap_or_default().to_string_lossy().to_string());
            push(name, launcher, game);
        }
    }
    for inst in subdirs(&home.join("curseforge").join("minecraft").join("Instances")) {
        let name = read_json_name(&inst.join("minecraftinstance.json"), &["name"]).unwrap_or_else(|| inst.file_name().unwrap_or_default().to_string_lossy().to_string());
        push(name, "CurseForge", inst);
    }
    for base in [roaming.join("ModrinthApp").join("profiles"), roaming.join("com.modrinth.theseus").join("profiles")] {
        for inst in subdirs(&base) {
            let name = inst.file_name().unwrap_or_default().to_string_lossy().to_string();
            push(name, "Modrinth", inst);
        }
    }
    for inst in subdirs(&roaming.join(".atlauncher").join("instances")) {
        let name = read_json_name(&inst.join("instance.json"), &["name", "launcher"]).unwrap_or_else(|| inst.file_name().unwrap_or_default().to_string_lossy().to_string());
        push(name, "ATLauncher", inst);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cw-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn write_read_list_plans() {
        let d = tmp("plans");
        let p = d.join("Plans").join("My base.chunkwise");
        write_text(p.to_str().unwrap(), r#"{"format":"chunkwise-plan","v":1,"id":"p1","sync":true,"meta":{"name":"My base"},"levels":{"l1":{"rows":"x"}}}"#).unwrap();
        write_text(d.join("Plans").join("broken.chunkwise").to_str().unwrap(), "{not json").unwrap();
        assert_eq!(read_text(p.to_str().unwrap()).unwrap().unwrap().len() > 10, true);
        assert!(read_text(d.join("nope").to_str().unwrap()).unwrap().is_none());
        let ps = list_plans(d.join("Plans").to_str().unwrap()).unwrap();
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].id, "p1");
        assert!(ps[0].sync);
        assert_eq!(ps[0].meta["name"], "My base");
        assert!(!d.join("Plans").join("My base.chunkwise.saving").exists());
        assert!(list_plans(d.join("missing").to_str().unwrap()).unwrap().is_empty());
    }
    #[test]
    fn bytes_and_rename() {
        let d = tmp("bytes");
        let p = d.join("schematics").join("base.schem");
        let ps = p.to_str().unwrap();
        write_bytes(ps, "AQID", true).unwrap();
        assert_eq!(fs::read(&p).unwrap(), vec![1, 2, 3]);
        assert_eq!(write_bytes(ps, "BAU=", false).unwrap_err(), "exists");
        write_bytes(ps, "BAU=", true).unwrap();
        assert_eq!(fs::read(&p).unwrap(), vec![4, 5]);
        let q = d.join("schematics").join("other.schem");
        rename(ps, q.to_str().unwrap()).unwrap();
        assert!(!p.exists() && q.exists());
        remove(q.to_str().unwrap(), false).unwrap();
        assert!(!q.exists());
        assert_eq!(list_dir(d.join("schematics").to_str().unwrap(), ".schem").unwrap().len(), 0);
    }
    #[test]
    fn instances() {
        let d = tmp("inst");
        let roaming = d.join("Roaming");
        let home = d.join("Home");
        fs::create_dir_all(roaming.join(".minecraft")).unwrap();
        let pi = roaming.join("PrismLauncher").join("instances").join("abc");
        fs::create_dir_all(pi.join("minecraft")).unwrap();
        fs::write(pi.join("instance.cfg"), "InstanceType=OneSix\nname=All the Mods 10\n").unwrap();
        let cf = home.join("curseforge").join("minecraft").join("Instances").join("Pack");
        fs::create_dir_all(&cf).unwrap();
        fs::write(cf.join("minecraftinstance.json"), r#"{"name":"Create Above"}"#).unwrap();
        let v = find_instances(&roaming, &home);
        let names: Vec<_> = v.iter().map(|i| format!("{} ({})", i.name, i.launcher)).collect();
        assert_eq!(names, vec!["Minecraft (Minecraft Launcher)", "All the Mods 10 (Prism Launcher)", "Create Above (CurseForge)"]);
        assert!(v[1].path.ends_with("minecraft"));
    }
}
