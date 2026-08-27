# Pimpampum app icon

`Pimpampum.icon` is the source of truth for the macOS application icon. It is an Apple Icon Composer document built from three flat SVG layers:

- a warm off-white background;
- the black lowercase `p` product mark;
- small red and blue status dots below the mark.

The separate files in `layers/` are editable source layers. `Pimpampum-flat.svg` is a portable flat reference, not the artifact shipped by the app.

`npm run build:macos` compiles the Icon Composer document with `actool`, packages both `Assets.car` and the backwards-compatible `Pimpampum.icns`, and produces `platforms/macos/dist/PimpampumMenuBar.app` (displayed to users as “pim • pam • pum”).
