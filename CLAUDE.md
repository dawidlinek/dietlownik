# dietlownik

Personal scraper + database for tracking dietly.pl meal-delivery (catering
diet) prices, promos, and menus over time. Node.js + TypeScript scraper into
Postgres. See `API.md` for the reverse-engineered dietly mobile API and
`db/schema.sql` for the data model.

## Design Context

### Users
A single user — the project owner — using this as a personal tool to make
better meal-delivery (catering diet) ordering decisions in Poland. They scrape
dietly.pl into Postgres and want a frontend that turns that warehouse into
fast, unambiguous answers: *which diet, which company, which city, at what
price, with what promo, right now*. They already know the domain (Polish
catering, kcal tiers, promo stacking), so the interface should respect that
expertise instead of teaching the basics.

The job-to-be-done: open the dashboard, pick a city + kcal target, see the
current best per-day prices across companies sorted by value, notice anything
that changed since last time, and decide what to order — in well under a
minute.

### Brand Personality
**Cozy, honest, sharp.**

- *Cozy*: warm, food-forward palette and typography. The interface should feel
  like a kitchen counter at 9pm, not a price-comparison portal.
- *Honest*: no marketing chrome, no urgency badges, no "best deal!" stickers.
  Numbers speak for themselves. Promo math is shown, not hidden.
- *Sharp*: dense, confident data presentation. This is a tool for someone who
  already knows what they're looking at — not a tutorial.

The voice is deadpan and competent. Think "someone smart cooked this up for
themselves" rather than "consumer app polished for retention."

Emotionally the interface should produce *quiet satisfaction* — the feeling
of a well-organized pantry where you can find what you need.

### Aesthetic Direction
Warm / food-forward, light theme only.

- **Palette**: tinted neutrals on a cream/oat base, never pure white. One
  honest food-derived accent (paprika, terracotta, olive, or burnt amber —
  pick one and commit). Tint the grays toward the accent hue for cohesion.
- **Typography**: a distinctive serif or warm humanist sans for display, paired
  with a refined neutral body face. Avoid Inter, Roboto, system defaults.
  Avoid mono as decoration — only use it where tabular alignment genuinely
  matters (price tables).
- **Layout**: generous but rhythmic — vary spacing rather than padding
  everything equally. Left-aligned, asymmetric where it earns the emphasis.
  Tables and number-grids are the hero, not cards.
- **Detail**: hairline rules over heavy borders, typography over chrome,
  numerals styled with care (tabular figures, considered weights for deltas
  and currency).

**Anti-reference (avoid at all costs)**: the Polish e-commerce default —
Allegro / Ceneo / Pyszne.pl aesthetic. Cluttered tables, banner stacks,
multiple competing CTAs, saturated reds, urgency badges, "promocja!" stickers.
Also avoid: generic SaaS indigo, AI-cyberpunk dark/cyan/glow, and
photography-as-decoration food-app energy.

### Design Principles

1. **Numbers are the design.** Per-day prices, deltas, kcal — typography,
   weight, and alignment do the work. No decorative charts, no sparklines as
   garnish. Charts must convey something the table can't.

2. **Warm, not cute.** Palette is food-derived (cream, paprika, olive, burnt
   amber); shapes are restrained. No cartoon mascots, no rounded-everything,
   no emoji as UI. The warmth comes from color and type, not whimsy.

3. **Honest math, visible promos.** Show the path from list price → promo →
   final per-day cost. Never hide the discount stack. If a promo expires soon,
   say so plainly; don't dramatize it with countdowns or urgency.

4. **Density with rhythm.** This is a personal tool — favor information
   density over breathing room, but vary spacing to create hierarchy. Tight
   inside a row, generous between sections. No identical-card grids.

5. **Respect the expert.** Use Polish domain terms as-is (kcal, dieta, tier,
   pakiet) — no unnecessary translation, no tooltips explaining the obvious.
   Polish-language data displayed natively.
