/**
 * Minimal leveled logger for the app.
 *
 * The app has no logging framework; this is a thin, dependency-free wrapper
 * over `console` with two goals:
 *
 *  - **Levels.** `debug`/`info` are developer traces; `warn`/`error` are
 *    failures worth keeping.
 *  - **Production hygiene.** `debug`/`info` are compiled out of release builds
 *    (gated on `__DEV__`), so verbose traces — including raw OCR label text —
 *    never reach production device logs. `warn`/`error` still emit in
 *    production so real failures stay visible (Xcode console / logcat, and any
 *    future crash-reporting hook can wrap these two).
 *
 * Call sites keep the existing `[tag]` prefix convention, e.g.
 * `log.debug('[extract] …')`.
 *
 * This is intentionally NOT a place for user-facing copy — that lives in
 * `format-error.ts`. Logs are developer-only and are never shown to users.
 */

// `__DEV__` is a global injected by the React Native / Expo runtime (and by
// jest-expo in tests): `true` in development, `false` in release builds.
declare const __DEV__: boolean;

type LogArgs = unknown[];

export const log = {
  /** Verbose developer trace. Dev-only — stripped from release builds. */
  debug: (...args: LogArgs): void => {
    if (__DEV__) console.log(...args);
  },
  /** Informational developer trace. Dev-only — stripped from release builds. */
  info: (...args: LogArgs): void => {
    if (__DEV__) console.info(...args);
  },
  /** Recoverable problem worth surfacing. Emits in all builds. */
  warn: (...args: LogArgs): void => {
    console.warn(...args);
  },
  /** Failure worth surfacing. Emits in all builds. */
  error: (...args: LogArgs): void => {
    console.error(...args);
  },
};