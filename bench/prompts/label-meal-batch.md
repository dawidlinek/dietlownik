# Labeling task

You are scoring how well each meal matches a single user-preference keyword
typed into a Polish catering-diet dashboard. Your scores become the ground
truth for evaluating embedding-model retrieval quality, so internal consistency
matters more than perfection on any one meal.

## Inputs

```json
{
  "query": "<keyword the user typed, raw — e.g. 'zdrowe', 'czerwone owoce', 'na łuszczycy', 'bez kurczaka'>",
  "query_family": "<one of: ingredient | category | category_gap | color_category | macro | tag | subjective | flavor | cuisine | clinical | meal_type | adversarial | typo | inflection | negation>",
  "query_notes": "<optional hint about query semantics>",
  "meals": [
    {
      "meal_id": 1234,
      "name": "Sałatka z grillowanym kurczakiem, awokado i rukolą",
      "label": "Lunch",
      "ingredients": "kurczak, awokado, rukola, pestki dyni, oliwa, sok z cytryny",
      "allergens": ["seler"],
      "kcal": 480,
      "protein_g": 38,
      "fat_g": 22,
      "carbs_g": 18,
      "fiber_g": 9,
      "sugar_g": 3,
      "salt_g": 1.1
    }
  ]
}
```

## Rubric — score each meal 0..10

|   Score | Meaning                                                                                                                                                                                                                       |
| ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  **10** | Textbook match. The keyword _defines_ this meal. (kurczak ↔ "Kurczak teriyaki z ryżem")                                                                                                                                       |
| **8–9** | Strong match. Keyword is a primary attribute of the meal. (zdrowe ↔ a clean, low-sugar, high-fiber, balanced salad with lean protein)                                                                                         |
| **6–7** | Partial / probable match. Keyword applies but isn't the headline feature, OR the inference is one short reasoning step away. (czerwone owoce ↔ "Owsianka z malinami i nasionami chia" — raspberries present but not dominant) |
| **4–5** | Tangential. The keyword is loosely related but a user asking for X would not be satisfied by this. (zdrowe ↔ a pasta carbonara — not unhealthy per se but nobody calls it "zdrowe")                                           |
| **2–3** | Mostly unrelated. Some incidental overlap (a single garnish ingredient, distant category) but not what the user wanted.                                                                                                       |
| **0–1** | Unrelated. (kurczak ↔ "Naleśniki z serem i konfiturą truskawkową")                                                                                                                                                            |

## Special rules for adversarial query families

- **negation** (`bez kurczaka`, `bez cebuli`): score 10 = meal **does not contain** the negated item; score 0 = meal **does contain** it. Inverted from the normal scale.
- **typo** (`kuczak`, `borkuł`, `lososs`): treat as the intended word and score against that intent.
- **inflection** (`kurczakiem`, `z kurczakiem`): treat as the base form (`kurczak`).
- **adversarial polysemy** (`kurka`, `ser`, `ostry`, `serce`): the keyword has multiple meanings. Score based on the **most plausible user intent in a catering context** — a user typing `kurka` in a meal app means chicken-diminutive far more often than chanterelle mushroom. Use surrounding ingredients to disambiguate per meal.
- **clinical** (`na łuszczycy`, `przeciwzapalne`, `dla cukrzyków`): apply nutritional-science knowledge. E.g. for psoriasis: anti-inflammatory (fatty fish, leafy greens, berries) = high; nightshades, refined sugar, alcohol = low. For diabetic: low GI carbs, no added sugar, balanced = high; sugar, white flour, sweet sauces = low.
- **macro** (`dużo białka`, `mało cukru`): use the provided macros directly. >25g protein per meal = high protein. <5g sugar = low sugar. Etc.

## Scoring discipline

1. **Use the macros.** Many subjective scores (`lekkie`, `sycące`, `wysokobiałkowe`) are objectively grounded in the kcal/macro fields. Don't guess at the meal's calorie load when it's printed in front of you.
2. **Read the ingredients list, not just the name.** A meal named "Sałatka cezar" with cream-based dressing and croutons scores differently from one with grilled chicken and a vinaigrette.
3. **Polish food vocabulary is the working assumption.** Treat all keywords and ingredients as Polish unless obviously not.
4. **Be consistent within a batch.** If meal A and meal B are nearly identical, their scores should be within 1 of each other.
5. **No mid-score bias.** It's fine if a batch contains many 0s or many 10s — don't compress toward 5.

## Output format

Return a single JSON object, no prose. Each meal in the input gets one entry,
in the same order:

```json
{
  "labels": [
    {
      "meal_id": 1234,
      "score": 8.5,
      "reason": "Lean protein + leafy greens + low sugar; textbook clean meal"
    },
    {
      "meal_id": 1235,
      "score": 2.0,
      "reason": "Pasta with cream sauce — not what 'zdrowe' usually means"
    }
  ]
}
```

- `score`: float in `[0, 10]`, one decimal place is fine.
- `reason`: one short sentence. Used for human spot-checking and for re-labeling disagreements with a stronger model later.
- Do not add fields. Do not omit meals. Do not wrap the JSON in markdown.
