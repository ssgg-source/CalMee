use super::{FunAsrRuntimeInstallPlan, FunAsrRuntimeInstallStatus};
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use sysinfo::Disks;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

const PYTHON_VERSION: &str = "3.11.15";
const UV_VERSION: &str = "0.11.7";
const MIN_FREE_BYTES: u64 = 2_200_000_000;

#[derive(Clone, Copy)]
struct TargetSpec {
    key: &'static str,
    lock: &'static str,
    uv_url: &'static str,
    uv_sha256: &'static str,
    archive: &'static str,
    download_bytes: u64,
    disk_bytes: u64,
}

fn target_spec() -> Option<TargetSpec> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(TargetSpec {
            key: "darwin-arm64",
            lock: "darwin-arm64.lock",
            uv_url: "https://github.com/astral-sh/uv/releases/download/0.11.7/uv-aarch64-apple-darwin.tar.gz",
            uv_sha256: "66e37d91f839e12481d7b932a1eccbfe732560f42c1cfb89faddfa2454534ba8",
            archive: "tar.gz",
            download_bytes: 300_000_000,
            disk_bytes: 1_600_000_000,
        }),
        ("linux", "x86_64") => Some(TargetSpec {
            key: "linux-x64",
            lock: "linux-x64.lock",
            uv_url: "https://github.com/astral-sh/uv/releases/download/0.11.7/uv-x86_64-unknown-linux-gnu.tar.gz",
            uv_sha256: "6681d691eb7f9c00ac6a3af54252f7ab29ae72f0c8f95bdc7f9d1401c23ea868",
            archive: "tar.gz",
            download_bytes: 5_000_000_000,
            disk_bytes: 12_000_000_000,
        }),
        ("windows", "x86_64") => Some(TargetSpec {
            key: "win32-x64",
            lock: "win32-x64.lock",
            uv_url: "https://github.com/astral-sh/uv/releases/download/0.11.7/uv-x86_64-pc-windows-msvc.zip",
            uv_sha256: "fe0c7815acf4fc45f8a5eff58ed3cf7ae2e15c3cf1dceadbd10c816ec1690cc1",
            archive: "zip",
            download_bytes: 350_000_000,
            disk_bytes: 1_800_000_000,
        }),
        _ => None,
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveRuntime {
    runtime_id: String,
    python: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    runtime_id: String,
    target: String,
    python_version: String,
    python: String,
    python_sha256: String,
    uv_version: String,
    uv_source: String,
    uv_sha256: String,
    requirements_sha256: String,
    lock_sha256: String,
    inventory_sha256: String,
    created_at: String,
}

static INSTALL_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static CANCEL: AtomicBool = AtomicBool::new(false);
static STATUS: Lazy<StdMutex<FunAsrRuntimeInstallStatus>> = Lazy::new(|| {
    StdMutex::new(FunAsrRuntimeInstallStatus::idle(
        "The local transcription runtime has not been installed.",
    ))
});

fn set_status(state: &str, progress: u32, message: impl Into<String>, retryable: bool) {
    if let Ok(mut status) = STATUS.lock() {
        *status = FunAsrRuntimeInstallStatus {
            state: state.into(),
            progress,
            message: message.into(),
            retryable,
        };
    }
}

pub fn install_status() -> FunAsrRuntimeInstallStatus {
    STATUS
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| {
            FunAsrRuntimeInstallStatus::idle("Runtime installer status is unavailable.")
        })
}

fn resource_file(relative: &str) -> Result<PathBuf> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative);
    let mut candidates = vec![development, PathBuf::from(relative)];
    if let Ok(root) = crate::app_paths::resource_root() {
        candidates.insert(0, root.join(relative));
        candidates.insert(1, root.join("_up/_up").join(relative));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| anyhow!("Required runtime installer resource is missing: {relative}"))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn sha256_matches(actual: &str, expected: &str) -> bool {
    actual == expected
}

fn safe_runtime_id(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('/')
        && !value.contains('\\')
        && value != "."
        && value != ".."
}

fn runtime_root() -> Result<PathBuf> {
    crate::app_paths::funasr_runtime_root().map_err(anyhow::Error::msg)
}

fn available_space(path: &Path) -> Result<u64> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    Disks::new_with_refreshed_list()
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(|disk| disk.available_space())
        .ok_or_else(|| anyhow!("Could not determine available disk space"))
}

pub fn install_plan() -> FunAsrRuntimeInstallPlan {
    let root = runtime_root().unwrap_or_else(|_| PathBuf::from("runtimes/funasr"));
    match target_spec() {
        Some(spec) => FunAsrRuntimeInstallPlan {
            supported: true,
            platform: spec.key.into(),
            runtime_download_bytes: spec.download_bytes,
            runtime_disk_bytes: spec.disk_bytes,
            runtime_directory: root.display().to_string(),
            model_directory: crate::app_paths::funasr_models_root()
                .unwrap_or_else(|_| PathBuf::from("models/funasr"))
                .display().to_string(),
            network_required: true,
            resumable: false,
            license_path: root.join("versions/<version>/third-party/NOTICE.txt").display().to_string(),
            message: "CalMee installs an isolated runtime once. Model weights are a separate download selected by you.".into(),
        },
        None => FunAsrRuntimeInstallPlan {
            supported: false,
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            runtime_download_bytes: 0,
            runtime_disk_bytes: 0,
            runtime_directory: root.display().to_string(),
            model_directory: crate::app_paths::funasr_models_root().unwrap_or_default().display().to_string(),
            network_required: false,
            resumable: false,
            license_path: String::new(),
            message: "This platform is not supported. Intel macOS is currently unavailable because the locked PyTorch release has no compatible wheel.".into(),
        },
    }
}

fn active_file(root: &Path) -> PathBuf {
    root.join("active.json")
}

pub fn active_python() -> Result<PathBuf> {
    let root = runtime_root()?;
    let active: ActiveRuntime = serde_json::from_slice(
        &std::fs::read(active_file(&root)).context("The FunASR runtime is not installed")?,
    )?;
    if !safe_runtime_id(&active.runtime_id) {
        bail!("Invalid runtime pointer");
    }
    let relative = PathBuf::from(&active.python);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        bail!("Invalid runtime Python path");
    }
    let version = root.join("versions").join(&active.runtime_id);
    let declared_python = version.join(&relative);
    let python = if declared_python.is_file() {
        declared_python
    } else {
        // uv 0.11 can create a version alias as an absolute symlink inside the
        // staging directory. Older CalMee installers recorded that alias, so
        // it became broken after the verified runtime was atomically moved.
        // Recover only the expected CPython executable inside this version.
        walk_find(
            &version,
            if cfg!(windows) {
                "python.exe"
            } else {
                "python3.11"
            },
        )
        .filter(|candidate| candidate.is_file())
        .ok_or_else(|| anyhow!("The active FunASR runtime Python is missing"))?
    };
    let manifest: RuntimeManifest =
        serde_json::from_slice(&std::fs::read(version.join("runtime.json"))?)?;
    let spec = target_spec().ok_or_else(|| anyhow!("This platform is not supported"))?;
    let lock = resource_file(&format!("funasr_sidecar/locks/{}", spec.lock))?;
    let requirements = resource_file("funasr_sidecar/requirements.txt")?;
    if manifest.schema_version != 3
        || manifest.runtime_id != active.runtime_id
        || manifest.target != spec.key
        || manifest.python_version != PYTHON_VERSION
        || manifest.python != active.python
        || manifest.uv_version != UV_VERSION
        || manifest.uv_source != spec.uv_url
        || manifest.uv_sha256 != spec.uv_sha256
        || manifest.requirements_sha256 != sha256_file(&requirements)?
        || manifest.lock_sha256 != sha256_file(&lock)?
        || manifest.python_sha256 != sha256_file(&python)?
        || manifest.inventory_sha256
            != sha256_file(&version.join("third-party/python-packages.json"))?
        || !version.join("third-party/NOTICE.txt").is_file()
        || !version.join("third-party/CPYTHON-LICENSE.txt").is_file()
    {
        bail!("The active FunASR runtime is incomplete");
    }
    Ok(python)
}

async fn download_verified(url: &str, expected: &str, destination: &Path) -> Result<()> {
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await?
        .error_for_status()?;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(destination).await?;
    let mut digest = Sha256::new();
    while let Some(chunk) = stream.next().await {
        if CANCEL.load(Ordering::Relaxed) {
            bail!("Installation cancelled");
        }
        let chunk = chunk?;
        digest.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    let actual = hex::encode(digest.finalize());
    if !sha256_matches(&actual, expected) {
        bail!("Downloaded installer hash did not match the pinned SHA-256");
    }
    Ok(())
}

fn extract_uv(archive: &Path, kind: &str, destination: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(destination)?;
    if kind == "zip" {
        let mut zip = zip::ZipArchive::new(File::open(archive)?)?;
        zip.extract(destination)?;
    } else {
        let decoder = flate2::read::GzDecoder::new(File::open(archive)?);
        let mut tar = tar::Archive::new(decoder);
        tar.unpack(destination)?;
    }
    let executable = if cfg!(windows) { "uv.exe" } else { "uv" };
    walk_find(destination, executable)
        .ok_or_else(|| anyhow!("Verified uv archive did not contain {executable}"))
}

fn walk_find(root: &Path, name: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_file() && entry.file_name() == name {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = walk_find(&path, name) {
                return Some(found);
            }
        }
    }
    None
}

fn remove_internal_absolute_symlinks(root: &Path, current: &Path) -> Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(&path)?;
            if target.is_absolute() {
                if !target.starts_with(root) {
                    bail!("The managed runtime contains an absolute link outside its staging directory");
                }
                std::fs::remove_file(path)?;
            }
        } else if metadata.is_dir() {
            remove_internal_absolute_symlinks(root, &path)?;
        }
    }
    Ok(())
}

async fn run_checked(program: &Path, args: &[String], envs: &[(&str, PathBuf)]) -> Result<String> {
    if CANCEL.load(Ordering::Relaxed) {
        bail!("Installation cancelled");
    }
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in envs {
        command.env(name, value);
    }
    let output = command.output().await?;
    if CANCEL.load(Ordering::Relaxed) {
        bail!("Installation cancelled");
    }
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        bail!(
            "Runtime setup command failed: {}",
            command_failure_detail(&detail)
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn model_cache_envs() -> Result<Vec<(&'static str, PathBuf)>> {
    let modelscope = crate::app_paths::funasr_modelscope_cache().map_err(anyhow::Error::msg)?;
    let huggingface = crate::app_paths::funasr_huggingface_cache().map_err(anyhow::Error::msg)?;
    std::fs::create_dir_all(&modelscope)?;
    std::fs::create_dir_all(&huggingface)?;
    Ok(vec![
        ("MODELSCOPE_CACHE", modelscope),
        ("HF_HOME", huggingface.clone()),
        ("HUGGINGFACE_HUB_CACHE", huggingface.join("hub")),
    ])
}

fn command_failure_detail(stderr: &str) -> String {
    let lines: Vec<_> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return "unknown error".into();
    }
    lines
        .iter()
        .rev()
        .take(8)
        .rev()
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
}

fn dependency_install_args(python: &Path, lock: &Path) -> Vec<String> {
    vec![
        "pip".into(),
        "install".into(),
        "--python".into(),
        python.display().to_string(),
        "--require-hashes".into(),
        // The interpreter is a fresh identifier-scoped copy installed in this
        // staging directory. uv marks managed CPython as externally managed,
        // so both flags are required to install into this private copy without
        // consulting or modifying any system Python environment.
        "--system".into(),
        "--break-system-packages".into(),
        "-r".into(),
        lock.display().to_string(),
    ]
}

fn atomic_activate(root: &Path, active: &ActiveRuntime) -> Result<()> {
    std::fs::create_dir_all(root)?;
    let mut temporary = tempfile::NamedTempFile::new_in(root)?;
    temporary.write_all(&serde_json::to_vec_pretty(active)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(active_file(root))
        .map_err(|error| error.error)?;
    Ok(())
}

fn promote_verified_runtime(
    root: &Path,
    staged_runtime: &Path,
    runtime_id: &str,
    python: &str,
) -> Result<()> {
    if !safe_runtime_id(runtime_id) || !staged_runtime.is_dir() {
        bail!("Verified runtime staging directory is invalid");
    }
    let final_dir = root.join("versions").join(runtime_id);
    if final_dir.exists() {
        bail!("Runtime version destination already exists");
    }
    std::fs::rename(staged_runtime, &final_dir)?;
    atomic_activate(
        root,
        &ActiveRuntime {
            runtime_id: runtime_id.into(),
            python: python.into(),
        },
    )
}

pub async fn install(confirmed: bool) -> Result<FunAsrRuntimeInstallStatus, String> {
    if !confirmed {
        return Err("Runtime installation requires explicit confirmation.".into());
    }
    let spec = target_spec().ok_or_else(|| install_plan().message)?;
    let _guard = INSTALL_LOCK.lock().await;
    if let Ok(python) = active_python() {
        if let Ok(sidecar) = resource_file("funasr_sidecar/main.py") {
            let cache_envs = model_cache_envs().unwrap_or_default();
            if run_checked(
                &python,
                &[sidecar.display().to_string(), "--self-test".into()],
                &cache_envs,
            )
            .await
            .is_ok()
            {
                set_status(
                    "ready",
                    100,
                    "The verified runtime is ready and can be reused offline.",
                    false,
                );
                return Ok(install_status());
            }
        }
    }
    CANCEL.store(false, Ordering::Relaxed);
    let result = install_inner(spec).await;
    match result {
        Ok(()) => {
            set_status(
                "ready",
                100,
                "The verified runtime is ready. Model weights remain a separate download.",
                false,
            );
            Ok(install_status())
        }
        Err(error) => {
            let cancelled = CANCEL.load(Ordering::Relaxed);
            set_status(
                if cancelled { "cancelled" } else { "failed" },
                0,
                error.to_string(),
                true,
            );
            Err(error.to_string())
        }
    }
}

async fn install_inner(spec: TargetSpec) -> Result<()> {
    let root = runtime_root()?;
    std::fs::create_dir_all(root.join("staging"))?;
    std::fs::create_dir_all(root.join("versions"))?;
    let free = available_space(&root)?;
    if free < spec.disk_bytes.max(MIN_FREE_BYTES) {
        bail!("Not enough disk space for the isolated runtime");
    }
    let lock = resource_file(&format!("funasr_sidecar/locks/{}", spec.lock))?;
    let requirements = resource_file("funasr_sidecar/requirements.txt")?;
    let notices = resource_file("funasr_sidecar/tools/generate-python-runtime-notices.py")
        .or_else(|_| resource_file("scripts/generate-python-runtime-notices.py"))?;
    let lock_hash = sha256_file(&lock)?;
    let base_runtime_id = format!("{}-{}-{}", PYTHON_VERSION, spec.key, &lock_hash[..12]);
    let runtime_id = if root.join("versions").join(&base_runtime_id).exists() {
        format!("{}-{}", base_runtime_id, &Uuid::new_v4().to_string()[..8])
    } else {
        base_runtime_id
    };
    let staging = root.join("staging").join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&staging)?;
    set_status(
        "downloadingBootstrap",
        10,
        "Downloading the pinned installer (retry starts this step again).",
        true,
    );
    let archive = staging.join(if spec.archive == "zip" {
        "uv.zip"
    } else {
        "uv.tar.gz"
    });
    download_verified(spec.uv_url, spec.uv_sha256, &archive).await?;
    set_status(
        "installingPython",
        25,
        format!("Installing isolated CPython {PYTHON_VERSION}…"),
        true,
    );
    let uv = extract_uv(&archive, spec.archive, &staging.join("bootstrap"))?;
    let runtime = staging.join("runtime");
    run_checked(
        &uv,
        &[
            "python".into(),
            "install".into(),
            PYTHON_VERSION.into(),
            "--install-dir".into(),
            runtime.display().to_string(),
        ],
        &[],
    )
    .await?;
    let python = walk_find(
        &runtime,
        if cfg!(windows) {
            "python.exe"
        } else {
            "python3.11"
        },
    )
    .ok_or_else(|| anyhow!("Managed CPython executable was not found after installation"))?
    .canonicalize()
    .context("Could not resolve the installed CPython executable")?;
    let canonical_runtime = runtime.canonicalize()?;
    if !python.starts_with(&canonical_runtime) {
        bail!("The installed CPython executable points outside the managed runtime");
    }
    remove_internal_absolute_symlinks(&canonical_runtime, &canonical_runtime)?;
    set_status(
        "installingDependencies",
        45,
        "Installing hash-locked FunASR dependencies…",
        true,
    );
    run_checked(&uv, &dependency_install_args(&python, &lock), &[]).await?;
    set_status(
        "generatingNotices",
        80,
        "Generating third-party dependency and license inventory…",
        true,
    );
    let inventory_output = run_checked(
        &python,
        &[notices.display().to_string(), runtime.display().to_string()],
        &[],
    )
    .await?;
    let inventory: serde_json::Value = serde_json::from_str(&inventory_output)?;
    set_status(
        "verifying",
        90,
        "Verifying the isolated runtime before activation…",
        false,
    );
    let sidecar = resource_file("funasr_sidecar/main.py")?;
    let cache_envs = model_cache_envs()?;
    run_checked(
        &python,
        &[sidecar.display().to_string(), "--self-test".into()],
        &cache_envs,
    )
    .await?;
    let manifest = RuntimeManifest {
        schema_version: 3,
        runtime_id: runtime_id.clone(),
        target: spec.key.into(),
        python_version: PYTHON_VERSION.into(),
        python: python
            .strip_prefix(&runtime)?
            .to_string_lossy()
            .replace('\\', "/"),
        python_sha256: sha256_file(&python)?,
        uv_version: UV_VERSION.into(),
        uv_source: spec.uv_url.into(),
        uv_sha256: spec.uv_sha256.into(),
        requirements_sha256: sha256_file(&requirements)?,
        lock_sha256: lock_hash,
        inventory_sha256: inventory
            .get("inventorySha256")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .into(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    std::fs::write(
        runtime.join("runtime.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    let relative = manifest.python;
    promote_verified_runtime(&root, &runtime, &runtime_id, &relative)?;
    if let Err(error) = std::fs::remove_dir_all(&staging) {
        log::warn!("Could not remove completed FunASR installer staging files: {error}");
    }
    Ok(())
}

pub fn cancel() -> FunAsrRuntimeInstallStatus {
    CANCEL.store(true, Ordering::Relaxed);
    set_status(
        "cancelRequested",
        install_status().progress,
        "Cancelling after the current safe operation…",
        true,
    );
    install_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_targets_are_blocked_before_network_work() {
        assert!(target_spec().is_some() || !install_plan().supported);
    }

    #[test]
    fn activation_switches_pointer_without_changing_old_version() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let old = root.join("versions/old");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("sentinel"), "unchanged").unwrap();
        atomic_activate(
            root,
            &ActiveRuntime {
                runtime_id: "old".into(),
                python: "bin/python".into(),
            },
        )
        .unwrap();
        atomic_activate(
            root,
            &ActiveRuntime {
                runtime_id: "new".into(),
                python: "bin/python".into(),
            },
        )
        .unwrap();
        let active: ActiveRuntime =
            serde_json::from_slice(&std::fs::read(active_file(root)).unwrap()).unwrap();
        assert_eq!(active.runtime_id, "new");
        assert_eq!(
            std::fs::read_to_string(old.join("sentinel")).unwrap(),
            "unchanged"
        );
    }

    #[test]
    fn integrity_mismatch_and_path_traversal_are_rejected() {
        let expected = hex::encode(Sha256::digest(b"verified fixture"));
        assert!(sha256_matches(
            &hex::encode(Sha256::digest(b"verified fixture")),
            &expected
        ));
        assert!(!sha256_matches(
            &hex::encode(Sha256::digest(b"tampered fixture")),
            &expected
        ));
        assert!(safe_runtime_id("3.11.15-darwin-arm64-abc123"));
        assert!(!safe_runtime_id("../shared-runtime"));
        assert!(!safe_runtime_id("folder/runtime"));
    }

    #[test]
    fn cancellation_is_retryable_and_never_marks_ready() {
        set_status("installingDependencies", 45, "fixture", true);
        let cancelled = cancel();
        assert_eq!(cancelled.state, "cancelRequested");
        assert!(cancelled.retryable);
        assert_ne!(cancelled.state, "ready");
        CANCEL.store(false, Ordering::Relaxed);
    }

    #[test]
    fn failed_promotion_keeps_the_old_runtime_active() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("versions/old")).unwrap();
        atomic_activate(
            root,
            &ActiveRuntime {
                runtime_id: "old".into(),
                python: "bin/python".into(),
            },
        )
        .unwrap();
        let error =
            promote_verified_runtime(root, &root.join("staging/missing"), "new", "bin/python")
                .unwrap_err();
        assert!(error.to_string().contains("staging"));
        let active: ActiveRuntime =
            serde_json::from_slice(&std::fs::read(active_file(root)).unwrap()).unwrap();
        assert_eq!(active.runtime_id, "old");
        assert!(!root.join("versions/new").exists());
    }

    #[test]
    fn dependency_install_targets_only_the_private_managed_python() {
        let args = dependency_install_args(
            Path::new("/private/runtime/bin/python"),
            Path::new("/resources/darwin-arm64.lock"),
        );
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--python", "/private/runtime/bin/python"]));
        assert!(args.iter().any(|arg| arg == "--system"));
        assert!(args.iter().any(|arg| arg == "--break-system-packages"));
        assert!(args.iter().any(|arg| arg == "--require-hashes"));
    }

    #[test]
    fn command_failures_keep_the_cause_instead_of_only_the_final_hint() {
        let detail = command_failure_detail(
            "error: interpreter is externally managed\n\n  private runtime\n\nhint: last line\n",
        );
        assert!(detail.contains("externally managed"));
        assert!(detail.contains("hint: last line"));
    }
}
