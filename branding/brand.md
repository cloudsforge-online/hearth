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

Tagline: **"Money mined at home. Made to spend."**

## Voice
Warm, plain, confident, a little defiant. We talk to people, not traders. We say
"money," "spend," "home," "fire," "you" — not "asset," "hodl," "protocol
maximalism." We're honest about limits (see the whitepaper threat model); trust is
part of the brand.

## Palette
Warm embers on hearthstone ink. Defined in `web/assets/styles.css`.

| Token | Hex | Use |
|---|---|---|
| Ink 900 | `#120d0a` | page background (hearthstone) |
| Ink 700 | `#1e1712` | cards |
| Line | `#38291f` | borders |
| Ember 500 | `#ff4d00` | primary flame |
| Ember 400 | `#ff7a18` | primary accents / buttons |
| Ember 300 | `#ff9e2c` | highlights |
| Gold 300 | `#ffc24b` | numbers, links |
| Gold 200 | `#ffd98a` | brightest glow, headings-in-gradient |
| Cream | `#f5ece0` | body text |

The signature gradient runs gold → ember for anything "lit": buttons, key
numbers, the wordmark accent.

## Logo
`web/assets/logo.svg` — a hearthstone arch (the home) cradling a single flame/ember
with a soft radial glow. It reads at favicon size and animates naturally (the
"living hearth" in the app grows brighter as you mine).

## Motion
The core motif is a **living fire**: a gentle flicker and rising embers
(`.flame` / `.ember-dot` in the CSS, ignited by `Hearth.igniteHearth`). In the app
the fire visibly grows with your mining activity — your contribution, made warm and
visible. All motion respects `prefers-reduced-motion`.

## Do / Don't
- **Do** lean into warmth, home, and people-power.
- **Do** show real numbers and admit trade-offs.
- **Don't** use cold "crypto-bro" chrome, lambos, or moon/gold hoarding imagery —
  that's the exact aesthetic Hearth rejects.
