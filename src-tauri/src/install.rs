//! Puts the bundled `aether-cli` on PATH as `aether`, and installs the agent skill.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const SKILL: &str = include_str!("../../skills/aether/SKILL.md");

/// The file beside a copied CLI that holds the app's path, for `aether open`.
pub const APP_PATH_FILE: &str = "aether-app.txt";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillStatus {
    Installed,
    UpdateAvailable,
    NotInstalled,
}

/// The folders Claude Code (`~/.claude/skills`) and Codex (`~/.agents/skills`) read.
fn skill_files(home: &Path) -> [PathBuf; 2] {
    [".agents", ".claude"].map(|dir| home.join(dir).join("skills/aether/SKILL.md"))
}

pub fn skill_status(home: &Path) -> SkillStatus {
    let found = skill_files(home).map(|file| fs::read_to_string(file).ok());
    if found.iter().all(|text| text.as_deref() == Some(SKILL)) {
        SkillStatus::Installed
    } else if found.iter().all(Option::is_none) {
        SkillStatus::NotInstalled
    } else {
        SkillStatus::UpdateAvailable
    }
}

pub fn install_skill(home: &Path) -> Result<(), String> {
    for file in skill_files(home) {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
        }
        fs::write(&file, SKILL).map_err(|e| format!("Failed to write {}: {e}", file.display()))?;
    }
    Ok(())
}

/// The CLI binary the bundler ships next to the app binary.
pub fn bundled_cli() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Cannot find the app: {e}"))?;
    cli_beside(&exe, std::env::var_os("APPIMAGE").is_some())
}

/// The CLI next to app binary `exe`. An AppImage runs from a temporary mount, so a link
/// into it breaks once the app quits.
fn cli_beside(exe: &Path, in_appimage: bool) -> Result<PathBuf, String> {
    if in_appimage {
        return Err(
            "The AppImage runs from a temporary folder, so it cannot install the CLI. Install the .deb or .rpm package to use it.".into(),
        );
    }
    let cli = exe.with_file_name(format!("aether-cli{}", std::env::consts::EXE_SUFFIX));
    if cli.exists() {
        Ok(cli)
    } else {
        Err("This build of Aether does not include the CLI".into())
    }
}

/// A copy of the CLI with a file beside it naming the app. Windows installs this, since
/// symlinks there need admin rights.
#[cfg(any(windows, test))]
mod copy {
    use super::*;

    fn app_file(target: &Path) -> PathBuf {
        target.with_file_name(APP_PATH_FILE)
    }

    /// True when `target` matches `cli` byte for byte and names `app`.
    pub fn installed(target: &Path, cli: &Path, app: &Path) -> bool {
        let names_app = fs::read_to_string(app_file(target)).is_ok_and(|p| Path::new(&p) == app);
        names_app && matches!((fs::read(target), fs::read(cli)), (Ok(a), Ok(b)) if a == b)
    }

    pub fn install(target: &Path, cli: &Path, app: &Path) -> Result<(), String> {
        let dir = target.parent().ok_or("Invalid CLI path")?;
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
        fs::copy(cli, target).map_err(|e| format!("Failed to copy the CLI: {e}"))?;
        fs::write(app_file(target), app.to_string_lossy().as_bytes())
            .map_err(|e| format!("Failed to write {}: {e}", app_file(target).display()))
    }

    /// Brings an installed copy up to date after an app update or move. Installs nothing new.
    pub fn refresh(target: &Path, cli: &Path, app: &Path) -> Result<(), String> {
        if target.exists() && !installed(target, cli, app) {
            install(target, cli, app)?;
        }
        Ok(())
    }

    pub fn remove(target: &Path) -> Result<(), String> {
        for file in [target.to_path_buf(), app_file(target)] {
            if file.exists() {
                fs::remove_file(&file)
                    .map_err(|e| format!("Failed to remove {}: {e}", file.display()))?;
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
pub use unix::*;

#[cfg(unix)]
mod unix {
    use super::*;

    /// Marks the shell wrapper that older versions installed on macOS.
    const WRAPPER_MARKER: &str = "# AETHER_CLI_WRAPPER";

    /// Homebrew's bin folder, which is on PATH: `/opt/homebrew/bin` on Apple Silicon, else
    /// `/usr/local/bin`.
    #[cfg(target_os = "macos")]
    pub fn cli_target() -> Result<PathBuf, String> {
        let homebrew = std::env::var("PATH")
            .is_ok_and(|path| path.split(':').any(|p| p == "/opt/homebrew/bin"));
        Ok(if homebrew || std::env::consts::ARCH == "aarch64" {
            PathBuf::from("/opt/homebrew/bin/aether")
        } else {
            PathBuf::from("/usr/local/bin/aether")
        })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn cli_target() -> Result<PathBuf, String> {
        dirs::home_dir()
            .map(|home| home.join(".local/bin/aether"))
            .ok_or_else(|| "Cannot find the home folder".to_string())
    }

    /// True when `target` is a symlink to `cli`.
    pub fn cli_installed(target: &Path, cli: &Path) -> bool {
        fs::read_link(target).is_ok_and(|dest| dest == cli)
    }

    /// Whether Aether put `target` there: a link to some copy's `aether-cli`, or the old wrapper.
    fn ours(target: &Path) -> bool {
        match fs::read_link(target) {
            Ok(dest) => dest.file_name() == Some("aether-cli".as_ref()),
            Err(_) => fs::read_to_string(target).is_ok_and(|text| text.contains(WRAPPER_MARKER)),
        }
    }

    /// Removes `target` if Aether put it there; refuses to touch anything else.
    fn remove_ours(target: &Path) -> Result<(), String> {
        if target.symlink_metadata().is_err() {
            return Ok(());
        }
        if !ours(target) {
            return Err(format!(
                "A different 'aether' command already exists at {}. Aether did not install it, so it was left alone.",
                target.display()
            ));
        }
        fs::remove_file(target).map_err(|e| format!("Failed to remove {}: {e}", target.display()))
    }

    pub fn install_cli(target: &Path, cli: &Path) -> Result<(), String> {
        remove_ours(target)?;
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
        }
        std::os::unix::fs::symlink(cli, target)
            .map_err(|e| format!("Failed to link {}: {e}", target.display()))
    }

    pub fn uninstall_cli(target: &Path) -> Result<(), String> {
        remove_ours(target)
    }
}

#[cfg(windows)]
pub use windows::*;

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Rewrites the user PATH in the registry, keeping `%VAR%` entries unexpanded, then sets and
    /// clears a variable through .NET so new terminals see the change.
    const PATH_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$path = (Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$parts = @($path -split ';' | Where-Object { $_ -and $_ -ne $env:AETHER_BIN })
if ($env:AETHER_ADD -eq '1') { $parts += $env:AETHER_BIN }
New-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value ($parts -join ';') -PropertyType ExpandString -Force | Out-Null
[Environment]::SetEnvironmentVariable('AETHER_PATH_REFRESH', '1', 'User')
[Environment]::SetEnvironmentVariable('AETHER_PATH_REFRESH', $null, 'User')
"#;

    /// `aether.exe` in a per-user folder that holds only the CLI copy.
    pub fn cli_target() -> Result<PathBuf, String> {
        dirs::data_local_dir()
            .map(|dir| dir.join("com.aether.app").join("bin").join("aether.exe"))
            .ok_or_else(|| "Cannot find the local app data folder".to_string())
    }

    fn app() -> Result<PathBuf, String> {
        std::env::current_exe().map_err(|e| format!("Cannot find the app: {e}"))
    }

    pub fn cli_installed(target: &Path, cli: &Path) -> bool {
        app().is_ok_and(|app| copy::installed(target, cli, &app))
    }

    pub fn install_cli(target: &Path, cli: &Path) -> Result<(), String> {
        copy::install(target, cli, &app()?)?;
        set_user_path(target.parent().ok_or("Invalid CLI path")?, true)
    }

    pub fn uninstall_cli(target: &Path) -> Result<(), String> {
        copy::remove(target)?;
        set_user_path(target.parent().ok_or("Invalid CLI path")?, false)
    }

    /// Run at startup: an app update leaves the installed copy on the old CLI.
    pub fn refresh_cli() -> Result<(), String> {
        copy::refresh(&cli_target()?, &bundled_cli()?, &app()?)
    }

    fn set_user_path(dir: &Path, add: bool) -> Result<(), String> {
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", PATH_SCRIPT])
            .env("AETHER_BIN", dir)
            .env("AETHER_ADD", if add { "1" } else { "0" })
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Failed to update PATH: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn read(path: &Path) -> Option<String> {
        fs::read_to_string(path).ok()
    }

    #[test]
    fn skill_is_not_installed_until_installed_into_both_folders() {
        let home = TempDir::new().unwrap();
        assert_eq!(skill_status(home.path()), SkillStatus::NotInstalled);

        install_skill(home.path()).unwrap();

        assert_eq!(skill_status(home.path()), SkillStatus::Installed);
        for file in skill_files(home.path()) {
            assert_eq!(read(&file).as_deref(), Some(SKILL));
        }
        assert!(home.path().join(".claude/skills/aether/SKILL.md").exists());
        assert!(home.path().join(".agents/skills/aether/SKILL.md").exists());
    }

    #[test]
    fn a_changed_or_missing_skill_file_is_an_update() {
        let home = TempDir::new().unwrap();
        install_skill(home.path()).unwrap();
        let [agents, claude] = skill_files(home.path());

        fs::write(&claude, "an older skill").unwrap();
        assert_eq!(skill_status(home.path()), SkillStatus::UpdateAvailable);

        install_skill(home.path()).unwrap();
        fs::remove_file(&agents).unwrap();
        assert_eq!(skill_status(home.path()), SkillStatus::UpdateAvailable);

        install_skill(home.path()).unwrap();
        assert_eq!(skill_status(home.path()), SkillStatus::Installed);
    }

    #[test]
    fn the_appimage_refuses_to_install_the_cli() {
        let dir = TempDir::new().unwrap();
        let exe = dir.path().join("Aether");
        fs::write(exe.with_file_name("aether-cli"), "cli").unwrap();
        assert!(cli_beside(&exe, false).is_ok());

        let err = cli_beside(&exe, true).unwrap_err();
        assert!(err.contains("AppImage"), "{err}");
    }

    mod copy_install {
        use super::*;

        struct Setup {
            _dir: TempDir,
            app: PathBuf,
            cli: PathBuf,
            target: PathBuf,
        }

        /// An installed app with its CLI, and a target in a bin folder that does not exist yet.
        fn setup() -> Setup {
            let dir = TempDir::new().unwrap();
            let app = dir.path().join("Aether/Aether.exe");
            let cli = app.with_file_name("aether-cli.exe");
            fs::create_dir_all(app.parent().unwrap()).unwrap();
            fs::write(&app, "app").unwrap();
            fs::write(&cli, "cli v1").unwrap();
            let target = dir.path().join("bin/aether.exe");
            Setup {
                _dir: dir,
                app,
                cli,
                target,
            }
        }

        fn app_file(s: &Setup) -> PathBuf {
            s.target.with_file_name(APP_PATH_FILE)
        }

        #[test]
        fn install_copies_the_cli_and_names_the_app_beside_it() {
            let s = setup();
            assert!(!copy::installed(&s.target, &s.cli, &s.app));

            copy::install(&s.target, &s.cli, &s.app).unwrap();

            assert_eq!(read(&s.target).as_deref(), Some("cli v1"));
            assert_eq!(read(&app_file(&s)).map(PathBuf::from), Some(s.app.clone()));
            assert!(copy::installed(&s.target, &s.cli, &s.app));
        }

        #[test]
        fn an_updated_cli_or_a_moved_app_is_out_of_date_until_refreshed() {
            let s = setup();
            copy::install(&s.target, &s.cli, &s.app).unwrap();
            fs::write(&s.cli, "cli v2").unwrap();
            assert!(!copy::installed(&s.target, &s.cli, &s.app));

            copy::refresh(&s.target, &s.cli, &s.app).unwrap();
            assert_eq!(read(&s.target).as_deref(), Some("cli v2"));
            assert!(copy::installed(&s.target, &s.cli, &s.app));

            let moved = s.app.with_file_name("Moved.exe");
            assert!(!copy::installed(&s.target, &s.cli, &moved));
            copy::refresh(&s.target, &s.cli, &moved).unwrap();
            assert!(copy::installed(&s.target, &s.cli, &moved));
        }

        #[test]
        fn refresh_leaves_an_uninstalled_cli_uninstalled() {
            let s = setup();
            copy::refresh(&s.target, &s.cli, &s.app).unwrap();
            assert!(!s.target.exists());
            assert!(!app_file(&s).exists());
        }

        #[test]
        fn remove_deletes_the_copy_and_its_app_file_and_is_fine_when_absent() {
            let s = setup();
            copy::remove(&s.target).unwrap();

            copy::install(&s.target, &s.cli, &s.app).unwrap();
            copy::remove(&s.target).unwrap();

            assert!(!s.target.exists());
            assert!(!app_file(&s).exists());
            assert!(s.cli.exists());
        }
    }

    #[cfg(unix)]
    mod cli {
        use super::*;
        use std::os::unix::fs::symlink;

        const WRAPPER: &str = "#!/bin/sh\n# AETHER_CLI_WRAPPER\nnohup '/Applications/Aether.app/Contents/MacOS/Aether' \"$@\" >/dev/null 2>&1 &\n";

        struct Setup {
            _dir: TempDir,
            cli: PathBuf,
            target: PathBuf,
        }

        /// A bundled CLI, and a target in a bin folder that does not exist yet.
        fn setup() -> Setup {
            let dir = TempDir::new().unwrap();
            let cli = dir.path().join("Aether.app/Contents/MacOS/aether-cli");
            fs::create_dir_all(cli.parent().unwrap()).unwrap();
            fs::write(&cli, "cli").unwrap();
            let target = dir.path().join("bin/aether");
            Setup {
                _dir: dir,
                cli,
                target,
            }
        }

        #[test]
        fn install_links_the_target_to_the_bundled_cli() {
            let s = setup();
            assert!(!cli_installed(&s.target, &s.cli));

            install_cli(&s.target, &s.cli).unwrap();

            assert_eq!(fs::read_link(&s.target).unwrap(), s.cli);
            assert!(cli_installed(&s.target, &s.cli));
        }

        #[test]
        fn install_replaces_the_old_wrapper_and_a_link_to_another_copy() {
            let s = setup();
            fs::create_dir_all(s.target.parent().unwrap()).unwrap();
            fs::write(&s.target, WRAPPER).unwrap();
            assert!(!cli_installed(&s.target, &s.cli));
            install_cli(&s.target, &s.cli).unwrap();
            assert!(cli_installed(&s.target, &s.cli));

            let moved = s.cli.with_file_name("old/aether-cli");
            fs::remove_file(&s.target).unwrap();
            symlink(&moved, &s.target).unwrap();
            assert!(!cli_installed(&s.target, &s.cli));
            install_cli(&s.target, &s.cli).unwrap();
            assert!(cli_installed(&s.target, &s.cli));
        }

        #[test]
        fn install_and_uninstall_leave_a_foreign_aether_alone() {
            let s = setup();
            fs::create_dir_all(s.target.parent().unwrap()).unwrap();
            fs::write(&s.target, "#!/bin/sh\necho someone else\n").unwrap();

            let err = install_cli(&s.target, &s.cli).unwrap_err();
            assert!(err.contains("different 'aether'"), "{err}");
            assert!(uninstall_cli(&s.target).is_err());
            assert_eq!(read(&s.target).unwrap(), "#!/bin/sh\necho someone else\n");

            fs::remove_file(&s.target).unwrap();
            let other = s.cli.with_file_name("other-tool");
            symlink(&other, &s.target).unwrap();
            assert!(install_cli(&s.target, &s.cli).is_err());
            assert!(uninstall_cli(&s.target).is_err());
            assert_eq!(fs::read_link(&s.target).unwrap(), other);
            assert!(!cli_installed(&s.target, &s.cli));
        }

        #[test]
        fn uninstall_removes_the_link_or_the_old_wrapper_and_is_fine_when_absent() {
            let s = setup();
            uninstall_cli(&s.target).unwrap();

            install_cli(&s.target, &s.cli).unwrap();
            uninstall_cli(&s.target).unwrap();
            assert!(s.target.symlink_metadata().is_err());
            assert!(s.cli.exists());

            fs::write(&s.target, WRAPPER).unwrap();
            uninstall_cli(&s.target).unwrap();
            assert!(s.target.symlink_metadata().is_err());
        }
    }
}
