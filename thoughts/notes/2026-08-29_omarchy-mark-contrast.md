# The Omarchy mark ignored the bar's resolved foreground

Date: 2026-08-29

Found during the live Omarchy run for the 1.1.0 release, on real hardware (Hyprland, Wayland,
Quickshell, theme Quattrocento, transparent bar). The bar widget rendered its circle-p mark in
white on a light wallpaper while every other bar icon rendered dark.

## What was wrong

`PimpampumMark.qml` chose between two fixed assets by the luminance of `contrastBackground`, which
`BarWidget.qml` fed from `bar.background`:

```qml
readonly property bool useLightAsset:
  (contrastBackground.r * 0.2126 + ...) < 0.5
```

On a transparent bar that input is meaningless. `Bar.qml` resolves the foreground by running
`omarchy-bar-text-color` against what is actually behind the bar, then:

```qml
property color barForeground: useTransparentForeground ? transparentForeground : themeForeground
```

Measured live with a probe in the installed plugin:

```
bar=present barForeground=#2a1e14 background=#2a1e14 transparent=true
```

Both properties hold the same value, and it is the colour to _paint with_. The old code read it as
the colour to contrast _against_, so it inverted the decision and painted white on white.

## Why the first fix was not enough

Replacing the asset choice with a `MultiEffect` (`colorization: 1.0`,
`colorizationColor: root.foreground`), copying `Tray.qml`, fixed the initial render and nothing
else. Changing the wallpaper moved every other icon to `#e6d7b2` while the mark stayed dark.
Instrumentation showed the binding delivering the new colour to the component:

```
PIMPAMPUM-BAR themeForeground=#e6d7b2 barForeground=#e6d7b2
PIMPAMPUM-MARK foreground=#e6d7b2
```

The value arrived; the pixels did not change. The effect samples the source through
`layer.enabled`, and that texture kept the colour of its first render. Verified by screenshot on a
forced black wallpaper, comparing the mark against a neighbouring icon.

Chosen instead: `Shape` + `ShapePath` + `fillColor: root.foreground`, which is what
`PimpampumHeaderIcon.qml` in this same plugin already does. No image, no layer, no cached texture,
and reactive by construction. Confirmed hot: light wallpaper → dark mark, black wallpaper → light
mark, with no shell restart.

The path now comes from `branding/assets/pimpampum-compact-master.svg`, and both
`scripts/validate-omarchy-plugin.mjs` and `test/omarchy-plugin.test.ts` fail if the QML path and
the reviewed master ever drift apart. `assets/pimpampum-compact-white.svg` is gone.

## Two traps this cost time on

**The QML engine keeps compiled components.** The corrected file sat on disk for five hours while
Quickshell kept rendering the old one: `rescanPlugins` reloads the plugin, but the engine reuses
what it already compiled. Warnings still cited a line number that only existed in the previous
version, and a `console.log` probe never fired. `omarchy restart shell` is required to verify any
plugin QML change.

**Text-matching invariants freeze the defect too.** The validator asserted
`'fixed mark must select an explicit high-contrast light or dark asset'` — the exact broken
decision. A fix is not complete until the rule that pinned it is rewritten.

## Not covered

The reviewer-driven Task 3.3 matrix was not run, so `thoughts/evidence/quattro-live.json` still does
not exist and `npm run check:quattro-evidence` still fails. That gate is not part of
`.github/workflows/release.yml`. What was verified instead: the four helpers against a real daemon,
the QML parsing functions executed against real CLI output (20/20), and this contrast behaviour
measured by screenshot on two wallpapers.
