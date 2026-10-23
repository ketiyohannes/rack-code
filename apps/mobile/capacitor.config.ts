/**
 * Capacitor configuration for the Rack mobile controller.
 *
 * The mobile app ships the same bundle as `apps/web`: `scripts/build-mobile.ts`
 * builds that app and copies its output into `./www`, which is what
 * `webDir` points at. Capacitor requires the web assets to live inside this
 * package, so the copy is a real step rather than a path into a sibling.
 *
 * Two settings are deliberate and security-relevant:
 *
 * - `androidScheme` is `https`. On Android the default `http` scheme puts
 *   the WebView in a non-secure context, which disables `crypto.randomUUID`
 *   and other secure-context APIs the controller uses, and would also make
 *   the pairing screen's own storage rules weaker than on the web.
 * - `cleartext` stays off. The controller already refuses a plaintext
 *   `ws://` to anything but loopback; allowing cleartext here would only
 *   create a way around that.
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.thinkingandcode.rack",
  appName: "Rack",
  webDir: "www",
  android: {
    // See the note above: a secure context is required by the controller.
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
    cleartext: false,
  },
};

export default config;
