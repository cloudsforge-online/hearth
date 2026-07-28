# Brand — Hearth

## The name
A **hearth** is the fire at the center of a home. It's the oldest human symbol of
warmth, belonging, and self-sufficiency — the opposite of a cold industrial server
farm. It captures the entire thesis in one word:

- **Anti-farm.** Not warehouses of ASICs — *hearths*, one in every home. Every
  home computer that mines is a fire keeping the network warm.
- **Human & everyday.** Money you actually live with and spend, not a vault you
  guard.
- **Emergent.** Thousands of small fires make more light than one bonfire —
  decentralization as a feeling, not a footnote.

**Coin: Ember.** The glowing piece of a fire — small, warm, alive, and what you
carry from one hearth to light another. EMBER is the unit you spend. Its smallest
subdivision is the **spark** (1e-8 EMBER).

The split is deliberate and stays: **Hearth is the network, Ember is the coin,
EMBER is the ticker, spark is the unit.** Do not collapse them.

Tagline: **"Money mined at home. Made to spend."**

## Where Hearth sits
Hearth is a [CloudsForge](https://cloudsforge.online) product, and the only public
one. CloudsForge is *one crypto world — mine it, trade it, mint it, spend it, play
in it*; **Hearth owns "mine."** That makes this the surface most outsiders meet the
company through, so it carries the shared chrome — the CloudsForge bar and product
switcher — on every page, and it is the one place the mine → convert → spend loop
gets told.

## Voice
Warm, plain, confident, a little defiant. We talk to people, not traders. We say
"money," "spend," "home," "fire," "you" — not "asset," "hodl," "protocol
maximalism." We're honest about limits (see the whitepaper threat model); trust is
part of the brand. When a figure is a model, the page says *"modeled — not a
promise."* When something is pre-mainnet, it says so in the same breath as the
claim, not in a footnote.

## Palette
**One substrate, one accent.** The darks, the type colours, the hairlines and the
radii are the CloudsForge house tokens from `@cloudsforge/ui`'s `tokens.css` — the
same ones every sibling product uses. The fire on top of them is Hearth's accent,
declared once in the surface registry (`@cloudsforge/shared/products`, `key:
'crypto'`) and selected by putting `data-cf-product="crypto"` on `<html>`.

Nothing in this repository declares an ember of its own. `site/src/index.css` and
`web/assets/styles.css` only *map* the shared tokens onto the names their markup
already used.

| Role | Token | Resolves to | Use |
|---|---|---|---|
| Page | `--cf-bg` | `#0e0c0a` | the coal-dark ground |
| Raised | `--cf-bg-raised` | `#141110` | panels, menus |
| Sunken | `--cf-bg-sunken` | `#0b0908` | code blocks, scrollbar track |
| Surfaces | `--cf-ash-800` … `--cf-ash-500` | `#1b1710` → `#493c2d` | cards, borders, dividers |
| Text | `--cf-fg` | `#ece5d6` | body and headings (*ash*) |
| Text, dim | `--cf-fg-dim` | `#b7ae9b` | secondary prose |
| Text, mute | `--cf-fg-mute` | `#8e866f` | eyebrows, labels (*soot*) |
| **Accent** | `--cf-accent` | **`#ff5a1e`** | the molten ember — buttons, focus, the one bright thing |
| Accent hover | `--cf-accent-hover` | `#ff8a3d` | hover, emphasis |
| Accent ink | `--cf-accent-ink` | `#1a0d05` | text laid on an ember fill |

Two values are Hearth's own and are *not* registry tokens: **flame `#ffb648`** and
**coal glow `#b62f18`**. They exist only as the two ends of the flame gradient —
the `.text-ember-wash` heading treatment, the rising sparks, and the mark — so the
accent has somewhere to burn to and cool into.

The signature gradient runs **flame → ember → coal glow** for anything "lit":
emphasised display words, the mark, the hero glow.

> An earlier version of this file documented a different palette — ember `#ff4d00`,
> gold `#ffc24b`, cream `#f5ece0`, ink `#120d0a`. That was `web/`'s, it never
> matched what the site shipped, and it is gone.

## Type
All three faces come from the shared tokens; the site loads them from Google Fonts.

- **Display** — Bricolage Grotesque, 800, tight tracking (`--cf-font-display`)
- **Sans** — Inter (`--cf-font-sans`)
- **Mono** — JetBrains Mono, used for eyebrows, stats, chips and buttons
  (`--cf-font-mono`)

## Marks
- **The mark** — `site/public/favicon.svg`, mirrored byte-for-byte at
  `web/assets/favicon.svg`: a single flame in the flame → ember → coal-glow
  gradient on a rounded coal square. It is the favicon everywhere, and the inline
  `FlameMark` fallback in `site/src/components/Logo.tsx` draws the same shape.
  There is exactly one Hearth mark; there used to be two.
- **The lockup** — `web/assets/logo.svg`: a hearthstone arch (the home) cradling
  that flame. Used at 24–120px in the explorer/wallet nav and in the README.
- **Social card** — `site/public/og-hearth.png`, 1200×630, served at
  `https://hearth.cloudsforge.online/og-hearth.png`. It is the `og:image` for
  the site *and* for the explorer, wallet and merchant demo. **Never point
  `og:image` at an SVG** — most scrapers will not render one, which is exactly
  what these pages used to do.
- **GitHub social preview** — `branding/social-hearth.png`, 1280×640. Same card
  at the dimensions GitHub rejects anything else for. Uploaded by hand in repo
  settings; it is never served.

The mark, wordmark, favicon source and both cards are generated by `asset-forge`
from the surface registry (`pnpm generate --track=brand`), not drawn by hand.

## Motion
The core motif is a **living fire**: a gentle flicker and rising embers (`.flame`
/ `.ember-dot` in `web/assets/styles.css`, ignited by `Hearth.igniteHearth`;
`.spark` / `.flame-flicker` / `.ember-pulse` on the site). In the app the fire
visibly grows with your mining activity — your contribution, made warm and
visible. All motion respects `prefers-reduced-motion`.

## Do / Don't
- **Do** lean into warmth, home, and people-power.
- **Do** show real numbers and admit trade-offs.
- **Do** carry the CloudsForge bar on every Hearth surface. It is how someone
  finds out there is more here than one coin.
- **Don't** write a hex for the ember. Change it in the registry, or don't change
  it.
- **Don't** use cold "crypto-bro" chrome, lambos, or moon/gold hoarding imagery —
  that's the exact aesthetic Hearth rejects.
- **Don't** imply EMBER has a price. It is pre-mainnet and testnet-only.
