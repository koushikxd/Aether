# Releasing

1. Bump the version in `package.json` and `src-tauri/tauri.conf.json`.
2. Commit to `main`, then tag and push: `git tag v0.5.0 && git push origin v0.5.0`.
3. The release workflow (`.github/workflows/release.yml`) builds every platform and creates a draft GitHub release.
4. When it finishes, update the description in `latest.json` from GitHub.
5. Review, edit the notes, and publish.
