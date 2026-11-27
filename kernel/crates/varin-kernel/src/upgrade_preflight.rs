use fs2::FileExt;
use serde_json::{Value, json};
use std::{fs::File, io::ErrorKind, path::{Path, PathBuf}};

fn stopped_owner(lock: &Path) -> std::io::Result<Option<File>> {
    let file = match File::open(lock) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    FileExt::try_lock_shared(&file).map_err(|error| std::io::Error::new(error.kind(),
        format!("Another process holds {}; stop the Host before preflight ({error})", lock.display())))?;
    Ok(Some(file))
}

fn result(value: Result<Value, impl ToString>) -> Value {
    value.unwrap_or_else(|error| json!({"status":"blocked", "reason":error.to_string()}))
}

fn inspect(root: &Path) -> std::io::Result<Value> {
    let catalog = root.join("agent-runtime");
    let _storage_owner = stopped_owner(&root.join("kernel.lock"))?;
    let _catalog_owner = stopped_owner(&catalog.join("runtime.owner"))?;
    Ok(json!({"storage": result(crate::storage::Storage::format_preflight(root)),
        "catalog": result(varin_runtime::catalog::format_preflight(&catalog))}))
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(2);
    let Some(root) = args.next().map(PathBuf::from).filter(|root| root.is_absolute()) else {
        return Err("--upgrade-preflight requires an absolute storage directory".into());
    };
    if args.next().is_some() {
        return Err("--upgrade-preflight takes exactly one storage directory".into());
    }
    println!("{}", inspect(&root)?);
    Ok(())
}
