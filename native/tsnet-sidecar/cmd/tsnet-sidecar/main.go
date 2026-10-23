// Command tsnet-sidecar exposes a local Rack daemon on a tailnet.
//
// It joins the tailnet as its own userspace node (no root, no TUN device, no
// changes to the host's routing table) and forwards everything that arrives on
// the node's port to the daemon's HTTP/WebSocket listener on loopback. A
// controller on another device in the same tailnet can then reach the daemon by
// its MagicDNS name without port forwarding, NAT traversal work or a relay.
//
// This file contains only process concerns: configuration, logging, signals and
// exit codes. The behavior lives in internal/config, internal/proxy,
// internal/sidecar and internal/tailnet.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"

	"github.com/rack/tsnet-sidecar/internal/config"
	"github.com/rack/tsnet-sidecar/internal/sidecar"
	"github.com/rack/tsnet-sidecar/internal/tailnet"
)

// Exit codes. They are distinct so that a supervisor (systemd in the VM images
// under infra/images) can tell a configuration mistake, which restarting will
// not fix, from a runtime failure, which restarting might.
const (
	exitOK            = 0
	exitConfiguration = 2
	exitRuntime       = 1
)

func main() {
	os.Exit(run())
}

// run holds main's logic so that every path can return an exit code instead of
// calling os.Exit, which would skip deferred cleanup.
func run() int {
	loader := config.Loader{
		LookupEnv: os.LookupEnv,
		ReadFile:  os.ReadFile,
		Output:    os.Stderr,
	}

	cfg, err := loader.Load(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			// The flag package already printed the usage text.
			return exitOK
		}
		// Configuration problems are printed plainly rather than as
		// structured logs: logging is not configured yet, and this text
		// is read by a human fixing a unit file or a command line.
		fmt.Fprintf(os.Stderr, "tsnet-sidecar: invalid configuration:\n%v\n", err)
		return exitConfiguration
	}

	logger := newLogger(cfg)
	logger.LogAttrs(context.Background(), slog.LevelInfo, "starting tsnet-sidecar",
		append([]slog.Attr{slog.String("version", buildVersion())}, cfg.LogAttrs()...)...)

	ctx, stop := signalContext(logger)
	defer stop()

	node, err := tailnet.New(cfg, logger)
	if err != nil {
		// A missing auth key with no saved identity lands here. It is a
		// configuration problem, not a transient one.
		logger.LogAttrs(ctx, slog.LevelError, "cannot prepare the tailnet node",
			slog.String("error", err.Error()))
		return exitConfiguration
	}

	if err := sidecar.Run(ctx, cfg, node, logger); err != nil {
		logger.LogAttrs(context.Background(), slog.LevelError, "tsnet-sidecar stopped with an error",
			slog.String("error", err.Error()))
		return exitRuntime
	}

	logger.LogAttrs(context.Background(), slog.LevelInfo, "tsnet-sidecar stopped")
	return exitOK
}

// newLogger builds the structured logger. JSON is the default because the
// expected home of this process is a systemd unit whose output is collected by
// the journal; text stays available for interactive debugging.
func newLogger(cfg config.Config) *slog.Logger {
	options := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "text" {
		return slog.New(slog.NewTextHandler(os.Stderr, options))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, options))
}

// signalContext returns a context cancelled by SIGINT or SIGTERM.
//
// The first signal starts the graceful drain in sidecar.Run. A second one
// aborts immediately: an operator who repeats the signal wants the process
// gone, and waiting out the drain timeout a second time is not helpful.
func signalContext(logger *slog.Logger) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		received := <-signals
		logger.LogAttrs(context.Background(), slog.LevelInfo, "signal received, draining",
			slog.String("signal", received.String()))
		cancel()

		received = <-signals
		logger.LogAttrs(context.Background(), slog.LevelWarn, "second signal received, exiting immediately",
			slog.String("signal", received.String()))
		// Deferred cleanup is deliberately skipped: this path exists
		// precisely because the orderly path is taking too long.
		os.Exit(exitRuntime)
	}()

	return ctx, func() {
		signal.Stop(signals)
		cancel()
	}
}

// buildVersion reports the module version or VCS revision recorded by the Go
// toolchain, so a running sidecar can be matched to the source it was built
// from. It is empty information rather than a guess when the binary was built
// outside a repository.
func buildVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	revision := ""
	modified := false
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			modified = setting.Value == "true"
		}
	}
	switch {
	case revision != "" && modified:
		return revision + "-dirty"
	case revision != "":
		return revision
	case info.Main.Version != "":
		return info.Main.Version
	default:
		return "unknown"
	}
}
