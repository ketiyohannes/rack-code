# apps/mobile

A Capacitor shell that packages the browser controller (`apps/web`) as an
iOS and Android app.

This is the cheap start the architecture calls for, and it is honest about
being one: the interface is framework-free and runs in a WebView unchanged,
so wrapping it costs almost nothing, but it is still a dense desktop layout
on a phone screen. See "Known limitation" below.

## Building

```sh
npm run build:mobile            # from the repository root
```

That builds `@rack/web` and stages its output in `./www` (source maps
stripped — they triple the payload, are useless inside a shipped app, and
shipping the controller's full source to a store build is not something to
do by accident). Capacitor copies `webDir` verbatim into the native
projects, which is why the bundle is staged inside this package rather than
referenced across the workspace.

Then, from `apps/mobile`:

```sh
npx cap add ios                 # once, per platform
npx cap add android
npm run sync                    # rebuild and copy into the native projects
npm run open:ios                # open Xcode
npm run open:android            # open Android Studio
```

## What this repository does and does not contain

The Capacitor configuration, the staging build and the npm scripts are here
and work. The generated `ios/` and `android/` directories are **not**
committed; `npx cap add` creates them from `capacitor.config.ts`. Producing
an actual installable app needs Xcode or Android Studio, a developer
account, and signing credentials, none of which live in this repository.

## Configuration decisions

- **`androidScheme` is `https`.** Android's default `http` scheme puts the
  WebView in a non-secure context, which disables `crypto.randomUUID` and
  the other secure-context APIs the controller relies on.
- **Cleartext is off.** The controller already refuses a plaintext `ws://`
  to anything but loopback; allowing cleartext here would only create a way
  around that.

## Pairing on a phone

The pairing screen is the same one the web app uses, and the storage rules
are the same: the token stays in `sessionStorage` unless "remember on this
device" is checked. On a personal phone that checkbox is the normal choice.

Typing a 43-character token on a phone keyboard is miserable, so scanning it
as a QR code from the daemon is the obvious next step — `rack-daemon
--print-token` deliberately prints the token alone on a line so it can be
piped into a QR generator. The scanner itself is not built yet.

## Known limitation

The layout is the desktop one. Panels, the navigator and the workbench all
assume a wide window, and no amount of WebView wrapping changes that. The
intended destination is a mobile-specific interface built on `@rack/client`
for the things a phone is actually good for — watching a run, answering an
approval or a question, and sending a prompt — rather than the full
workspace. That interface is not written yet.
