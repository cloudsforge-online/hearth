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

> **The CSS that this section used to describe is not in this repository any more.**
> `web/assets/styles.css` and `site/src/index.css` were deleted on 2026-08-04
> (`48bc28a`). Nothing here declares, maps or ships a design token. **The tokens are
> real, but they live in `@cloudsforge/ui`** — `packages/ui/src/tokens.css` in
> [`micro-ui`](https://github.com/cloudsforge-online/micro-ui) — and that package is
> the only thing that should be cited for a value.

**One substrate, one accent.** The darks, the type colours, the hairlines and the radii
are the CloudsForge house tokens, the same ones every sibling product uses. The fire on
top of them is the product accent, declared once in the surface registry
(`@cloudsforge/ui`'s `src/surfaces.ts`) and selected by a `data-cf-product` attribute
on `<html>`.

> ### Three claims in this file were wrong, and they are corrected below
>
> 1. **The accent is not `#ff5a1e`.** That value is on the estate's `RETIRED_ACCENTS`
>    list (`ui/packages/ui/src/surfaces.ts:193`), which exists so a retired colour can
>    "never reappear anywhere in the registry". It was retired because the switcher
>    could not tell Hearth's orange from the company ember `#e8622c` — dE 4.1 (`:132`).
> 2. **There is no `crypto` product key.** Hearth is the **`network`** surface —
>    `key: 'network'`, `name: 'Forge Network'`, `verb: 'Mine'`
>    (`ui/packages/ui/src/surfaces.ts:235-247`). The selector is
>    `data-cf-product="network"` (`ui/packages/ui/src/tokens.css:519`).
> 3. **The registry is not `@cloudsforge/shared/products`.** No such package exists in
>    the estate. It is `@cloudsforge/ui`.

Hearth's accent, as the registry actually declares it
(`ui/packages/ui/src/tokens.css:519-525`):

| Role | Token | Resolves to | Use |
|---|---|---|---|
| Page | `--cf-bg` | `#0e0c0a` | the coal-dark ground (`--cf-ash-900`, `tokens.css:126`) |
| Raised | `--cf-bg-raised` | `#141110` | panels, menus (`--cf-ash-850`, `:127`) |
| Sunken | `--cf-bg-sunken` | `#0b0908` | code blocks, scrollbar track (`--cf-ash-950`, `:125`) |
| Surfaces | `--cf-ash-800` … `--cf-ash-500` | `#1b1710` → `#493c2d` | cards, borders, dividers (`:128`, `:131`) |
| Text | `--cf-fg` | `#ece5d6` | body and headings (`--cf-bone`, `:134`) |
| Text, dim | `--cf-fg-dim` | `#b7ae9b` | secondary prose (`:135`) |
| Text, mute | `--cf-fg-mute` | `#8e866f` | eyebrows, labels (`:136`) |
| **Accent** | `--cf-accent` | **`#d6412f`** | the ember — buttons, focus, the one bright thing |
| Accent hover | `--cf-accent-hover` | `#ef5a45` | hover, emphasis |
| Accent ink | `--cf-accent-ink` | `#0a0202` | text laid on an ember fill |
| Accent **text** | `--cf-accent-text` | `#ff5b43` | accent-coloured *type*. `#d6412f` is 3.11:1 — the worst in the set — so type never uses the raw accent |
| Accent glow | `--cf-accent-glow` | `rgba(214, 65, 47, 0.26)` | the hero glow |

**Use `--cf-accent-text`, not `--cf-accent`, for text.** That is not a preference: the
registry records the raw accent at 3.11:1, below the contrast floor, and ships a
separate token for type at 4.55:1.

**A product accent is drawn as an outline, not as a fill with type on it**
(`ui/packages/ui/src/tokens.css:515-518`).

> **Flame `#ffb648` and coal glow `#b62f18` no longer exist anywhere.** They were never
> registry tokens — they were declared only in the two stylesheets that have been
> deleted, as the ends of a flame gradient. A search of the estate finds neither value
> in any `.css`, `.ts`, `.tsx` or `.svg`. **The flame → ember → coal-glow gradient this
> file used to specify is therefore not implemented by anything.** Either it is
> reintroduced in `@cloudsforge/ui` as real tokens, or it stops being described as
> though it ships. It is recorded here as *removed*, not as *available*.

> An earlier version of this file documented a different palette again — ember
> `#ff4d00`, gold `#ffc24b`, cream `#f5ece0`, ink `#120d0a`. That was `web/`'s, it
> never matched what the site shipped, and `#ff4d00` is also on `RETIRED_ACCENTS`.

## Type
All three faces come from the shared tokens; the site loads them from Google Fonts.

- **Display** — Bricolage Grotesque, 800, tight tracking (`--cf-font-display`)
- **Sans** — Inter (`--cf-font-sans`)
- **Mono** — JetBrains Mono, used for eyebrows, stats, chips and buttons
  (`--cf-font-mono`)

## Marks

Everything below is in `branding/`, and that is now the whole of it — this repository
serves no pages, so nothing here is referenced by a stylesheet or a `<link>` any more.

- **The lockup** — `branding/logo.svg`: a hearthstone arch (the home) cradling the
  flame. **It moved here from `web/assets/logo.svg` in `48bc28a` rather than being
  deleted with the rest**, because it is the only vector source in the repository and
  `app-desktop` generates its application icons from it.
- **The raster marks** — `branding/mark-hearth.png`, `branding/hearth-logo.png`,
  `branding/wordmark-hearth.png`, `branding/favicon-hearth.png`.
- **Social card** — `branding/og-hearth.png`, 1200×630. It **is** still in this
  repository, but nothing in this repository serves it; it is no longer the `og:image`
  of anything here, because the pages that set that tag are gone. The rule it was
  written for still holds wherever it is used: **never point `og:image` at an SVG** —
  most scrapers will not render one.
- **GitHub social preview** — `branding/social-hearth.png`, 1280×640. Same card at the
  dimensions GitHub rejects anything else for. Uploaded by hand in repo settings; it is
  never served.

> **There is no SVG favicon in this repository.** `site/public/favicon.svg` and its
> byte-for-byte mirror `web/assets/favicon.svg` were deleted, as was the inline
> `FlameMark` fallback in `site/src/components/Logo.tsx`. `branding/favicon-hearth.png`
> is a raster, not the vector source. The mark's vector form now exists only inside
> `branding/logo.svg` and in the generated assets held by
> [`micro-brand`](https://github.com/cloudsforge-online/micro-brand).

The mark, wordmark, favicon source and both cards are generated by `asset-forge`
from the surface registry (`pnpm generate --track=brand`), not drawn by hand.

## Motion

The core motif is a **living fire**: a gentle flicker and rising embers, and in a mining
surface the fire grows with your activity — your contribution, made warm and visible.
All motion must respect `prefers-reduced-motion`.

> **This is now an intent, not a description of shipped code.** The classes that
> implemented it — `.flame` and `.ember-dot`, ignited by `Hearth.igniteHearth`, and the
> site's `.spark` / `.flame-flicker` / `.ember-pulse` — were declared in
> `web/assets/styles.css` and `site/src/index.css`, both deleted in `48bc28a`. **No
> stylesheet in this repository implements any of them.** Anything rebuilding this motif
> is writing it fresh, against `@cloudsforge/ui`, not restoring something described here.

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
