## Downloads

| Platform | File |
| --- | --- |
| macOS, Apple silicon | `Rack-<version>-macos-arm64.zip` |
| macOS, Intel | `Rack-<version>-macos-x64.zip` |
| Windows x64 | `Rack-<version>-windows-x64.zip` |
| Linux x64 | `Rack-<version>-linux-x64.tar.gz` |

## Installing

These builds are **not signed or notarized**, so each system will warn about
them. The steps below are what that costs.

**macOS.** Expand the archive, move `Rack.app` to `/Applications`, then clear
the download quarantine flag:

```
xattr -dr com.apple.quarantine /Applications/Rack.app
```

Without this macOS reports the app as damaged. It is the expected result of
downloading an application that carries only an ad-hoc signature.

**Windows.** Expand the archive and run `Rack.exe`. SmartScreen will warn
about an unrecognized publisher: choose **More info**, then **Run anyway**.

**Linux.** Expand the archive and run `./Rack` from the extracted directory.

## Before you sign in

The Codex runtime ships inside the application; nothing to install.

Connecting a **Claude** account still requires the Claude Code CLI on your
`PATH`, because sign-in and the connection check run the `claude` command.
Verify it with `claude --version` before connecting an account in
**Settings → Accounts**.

## Where your data lives

Projects, sessions and account records are kept locally in `~/.rack`. An
installation that still holds a `~/.thinking-and-code` directory from before
the application was renamed adopts it automatically on first start.
