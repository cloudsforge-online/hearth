# web/art — masters

asset-forge writes its output for the web bundle here, not into `../assets`,
because `../assets` is *served*. These are 1536×1024 photographic PNGs of around
2 MB; the pages render them at 1400px wide, and PNG is the wrong container for a
painted image anyway — the same picture is 75 KB as webp.

So masters live here and the served pair is derived from them:

```bash
# from web/
sips -Z 1400 art/mine-hero.png --out /tmp/h.png
sips -s format jpeg -s formatOptions 82 /tmp/h.png --out assets/mine-hero.jpg
cwebp -q 82 /tmp/h.png -o assets/mine-hero.webp
```

Needs macOS `sips` and `cwebp` (`brew install webp`) — the same two tools the
game's `apps/game/art/build.mjs` uses.

| | |
|---|---|
| master | 1,998 KB |
| served webp | 75 KB |
| served jpeg (fallback) | 239 KB |

Pages reference them with `<picture>`, webp first. Nothing in `src` hard-fails on
a missing image: the mining page simply renders without one.
