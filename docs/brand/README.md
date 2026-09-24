# Brand

The Polyphemus mark: one eye — a ring with a pupil, and the stroke that ran straight through the
first mark now running out either side of it. Round caps, one accent, three elements, the way the
first one was drawn (2026-09-21).

Where they're used:

| In the app | From |
|---|---|
| `packages/daemon/web/icon.svg` (favicon) | `favicon.svg` |
| `icon-192.png`, `icon-512.png` (home screen) | rendered from `polyphemus-app-icon-1024.svg` |
| `icon-maskable-512.png` (Android adaptive) | the app icon, full bleed with the mark inside the safe zone |
| `badge.png` (Android notification badge) | `polyphemus-mark-small.svg`, white — Android draws only the alpha |
| the logo in the app bar and rail | `polyphemus-mark-small` on the favicon's tile: it's drawn below 32px |

Accent `#FF4B1F`, ink `#1A1A18`, light tile `#F2EFE8`. The name is written Polyphemus; what you
type is `poly`.

## Social

`social/` holds the X (and anywhere else) profile artwork, each an HTML page drawn with the app's own
fonts, and the PNG rendered from it at the size the site wants:

| File | Size | For |
|---|---|---|
| `social/avatar.png` | 400×400 | the profile picture (shown as a circle; the mark sits well inside it) |
| `social/header.png` | 1500×500 | the profile header: the words sit right of where the avatar overlaps, in the band phones don't crop |
| `social/card.png` | 1200×675 | a 16:9 image for a pinned or launch post, shown uncropped in the feed |

To change one, edit its `.html` and render it again:
`google-chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1500,500 --screenshot="$PWD/header.png" "file://$PWD/header.html"` (from `docs/brand/social`, with that file's size).
