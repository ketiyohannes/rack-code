package tailnet

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rack/tsnet-sidecar/internal/config"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// testConfig builds a valid configuration whose state directory is a temporary
// one. Nothing here contacts a control plane.
func testConfig(t *testing.T, stateDir string, authKey string) config.Config {
	t.Helper()

	env := map[string]string{}
	if authKey != "" {
		env[config.EnvAuthKey] = authKey
	}
	cfg, err := config.Loader{
		LookupEnv: func(name string) (string, bool) {
			v, ok := env[name]
			return v, ok
		},
	}.Load([]string{
		"-hostname", "rack-daemon",
		"-state-dir", stateDir,
		"-target", "127.0.0.1:7357",
	})
	if err != nil {
		t.Fatalf("building the test configuration: %v", err)
	}
	return cfg
}

func TestVerifyIdentityAvailable(t *testing.T) {
	t.Parallel()

	t.Run("an auth key is enough", func(t *testing.T) {
		t.Parallel()
		if err := VerifyIdentityAvailable(filepath.Join(t.TempDir(), "absent"), true); err != nil {
			t.Fatalf("VerifyIdentityAvailable: %v", err)
		}
	})

	t.Run("a saved identity is enough", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, StateFileName), []byte("{}"), 0o600); err != nil {
			t.Fatalf("writing the state file: %v", err)
		}
		if err := VerifyIdentityAvailable(dir, false); err != nil {
			t.Fatalf("VerifyIdentityAvailable: %v", err)
		}
	})

	t.Run("neither is a loud failure", func(t *testing.T) {
		t.Parallel()
		err := VerifyIdentityAvailable(t.TempDir(), false)
		if err == nil {
			t.Fatal("VerifyIdentityAvailable succeeded with no key and no saved identity; the sidecar would hang on interactive login")
		}
		for _, want := range []string{config.EnvAuthKey, config.EnvAuthKeyFile, "interactive login"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error %q does not mention %q", err, want)
			}
		}
	})
}

func TestNewPreparesThePrivateStateDirectory(t *testing.T) {
	t.Parallel()

	stateDir := filepath.Join(t.TempDir(), "tsnet")
	node, err := New(testConfig(t, stateDir, "tskey-auth-test"), discardLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if node == nil {
		t.Fatal("New returned no node")
	}

	info, err := os.Stat(stateDir)
	if err != nil {
		t.Fatalf("the state directory was not created: %v", err)
	}
	if perm := info.Mode().Perm(); perm != StateDirMode.Perm() {
		// The saved node key authenticates this machine to the tailnet.
		t.Errorf("state directory mode = %v, want %v so the node key stays private", perm, StateDirMode.Perm())
	}
}

func TestNewRefusesToStartWithoutAnyIdentity(t *testing.T) {
	t.Parallel()

	stateDir := filepath.Join(t.TempDir(), "tsnet")
	_, err := New(testConfig(t, stateDir, ""), discardLogger())
	if err == nil {
		t.Fatal("New succeeded without an auth key and without saved state")
	}
}

func TestNewRequiresALogger(t *testing.T) {
	t.Parallel()

	if _, err := New(testConfig(t, t.TempDir(), "tskey-auth-test"), nil); err == nil {
		t.Fatal("New accepted a nil logger")
	}
}

// TestScrubberRemovesCredentials covers the defensive net applied to every log
// line the Tailscale library produces.
func TestScrubberRemovesCredentials(t *testing.T) {
	t.Parallel()

	const key = "tskey-auth-k1CDEF-abcdef0123456789"
	scrub := newScrubber(key)

	cases := []struct {
		name string
		line string
	}{
		{"the configured key", "registering with " + key},
		{"another key-shaped token", "control said tskey-auth-other-0123456789 expired"},
		{"a key inside a URL", "GET https://controlplane.example/register?key=" + key + "&v=1"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := scrub(tc.line)
			if strings.Contains(got, "tskey-") {
				t.Errorf("scrubbed line %q still contains key material", got)
			}
			if !strings.Contains(got, config.Redacted) {
				t.Errorf("scrubbed line %q does not show the redaction marker", got)
			}
		})
	}

	if got := scrub("node is up"); got != "node is up" {
		t.Errorf("ordinary lines must pass through unchanged, got %q", got)
	}
}
