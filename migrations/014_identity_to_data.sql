-- ---------------------------------------------------------------------------
-- Move this deployment's identity out of the code and into its own row.
--
-- WHY. The niches, the personas and the scoring brief were constants in
-- src/config.js, src/outreach.js and src/ai.js — which meant that anyone who
-- cloned this repository inherited one particular person's taxonomy, sales copy
-- and scoring brief, and had to edit source files to get rid of them.
--
-- Configuration belongs in the database, where a profile already keeps it. The
-- code keeps a deliberately neutral fallback so a fresh install runs, and every
-- deployment writes its own identity here on first run.
--
-- This changes NOTHING about how this deployment behaves: withConfig() already
-- prefers the stored JSON over the built-in default, so the same values simply
-- arrive from a different place. Apply this BEFORE deploying the genericised
-- code, and the switch is invisible.
--
-- Safe to re-run.
--   pnpm exec wrangler d1 execute lead-finder --remote --file=./migrations/014_identity_to_data.sql
-- ---------------------------------------------------------------------------

UPDATE profiles SET
  niches    = '{"alt_fashion": {"label": "Alternative fashion", "keywords": ["emo", "goth", "gothic", "nu goth", "pastel goth", "punk", "grunge", "metalcore", "scene", "alt fashion", "alternative clothing", "alternative fashion", "subculture", "occult", "witchy", "cutecore", "cute", "kawaii", "pastel", "coquette", "fairycore", "dollette", "babycore", "sanrio", "plushie", "bows", "ribbon", "harajuku", "lolita", "gothic lolita", "sweet lolita", "classic lolita", "jirai kei", "visual kei", "fairy kei", "mori kei", "dolly kei", "yami kawaii", "menhera", "gyaru", "decora", "shironuri", "jfashion", "japanese street", "japanese inspired", "tokyo", "kimono", "yukata", "y2k", "90s", "vintage", "thrifted", "deadstock", "upcycled", "reworked", "streetwear", "corset", "platform boots", "handmade clothing"]}, "craft_goods": {"label": "Handmade & craft goods", "keywords": ["handmade", "ceramic", "ceramics", "pottery", "jewelry", "jewellery", "stationery", "enamel pin", "sticker", "zine", "print shop", "art object", "woodwork", "textile", "weaving", "candle", "artisan"]}, "beauty_wellness": {"label": "Beauty & skincare", "keywords": ["skincare", "skin care", "serum", "cleanser", "moisturizer", "beauty", "cosmetics", "fragrance", "perfume", "balm", "apothecary", "wellness"]}, "food_bev": {"label": "Food & beverage", "keywords": ["coffee", "roaster", "tea", "chocolate", "bakery", "hot sauce", "condiment", "snack", "granola", "kombucha", "brewery", "distillery", "small batch", "provisions", "pantry"]}, "artist_portfolio": {"label": "Artist / creator portfolio", "keywords": ["illustrator", "illustration", "painter", "fine art", "photographer", "photography", "portfolio", "commissions", "musician", "band", "tattoo artist", "animator", "sculptor", "printmaker"]}, "creative_studio": {"label": "Creative studio / agency", "keywords": ["design studio", "creative studio", "branding agency", "design agency", "creative agency", "art direction", "production studio", "film studio", "photo studio", "we help brands", "our clients", "case study"]}, "lifestyle_brand": {"label": "Creative lifestyle brand", "keywords": ["home goods", "homeware", "lifestyle", "apparel", "accessories", "concept store", "boutique", "curated", "slow living"]}}',
  personas  = '{"alt_fashion": {"label": "Alternative fashion", "context": "I design and build websites for independent fashion labels — the kind where the site needs to carry as much personality as the clothes do.", "subject": "{name} — a few notes on your site", "offer": "a short written breakdown of what I would change on the shop pages, with a rough visual of how it could look"}, "craft_goods": {"label": "Handmade & craft", "context": "I design and build websites for independent makers and studios, so the site does justice to work that is made by hand.", "subject": "{name} — a few notes on your shop pages", "offer": "a short written breakdown of what I would change, with a rough visual of how the shop could feel closer to the objects themselves"}, "beauty_wellness": {"label": "Beauty & skincare", "context": "I design and build websites for independent beauty and skincare brands, where most of the decision happens on the product page.", "subject": "{name} — notes on your product pages", "offer": "a short written breakdown of what I would change on the product pages, and why"}, "food_bev": {"label": "Food & beverage", "context": "I design and build websites and ordering systems for small food and drink brands.", "subject": "{name} — a thought on your ordering flow", "offer": "a short teardown of the ordering flow with the specific changes I would make"}, "artist_portfolio": {"label": "Artist portfolio", "context": "I design and build portfolio sites for artists and illustrators — properly built, not a template with your images dropped in.", "subject": "Your work and where it lives", "offer": "a rough layout for what a real portfolio site could look like for your work"}, "creative_studio": {"label": "Creative studio", "context": "I build websites and internal tools for creative studios — usually the work that gets postponed because client projects come first.", "subject": "{name} — a note on your own site", "offer": "a short written assessment of your site and the workflow around it, with what I would prioritise"}, "lifestyle_brand": {"label": "Creative lifestyle brand", "context": "I design and build websites for independent brands with a clear identity of their own.", "subject": "{name} — a few notes on your site", "offer": "a short written breakdown of what I would change, with a rough visual of where it could go"}}',
  ai_system = 'You are helping Lucia, a freelance web developer and designer, decide who is worth contacting.

Lucia builds websites and custom business systems for founder-led creative businesses in the United States. Her work is expressive, artistic, and built around the personality of the brand. She is not a generic agency and does not want generic corporate clients.

She has TWO separate service lines, and you must evaluate them independently:
  A. WEBSITE / DIGITAL EXPERIENCE — the site is bad, dated, generic, or fails the brand.
  B. SYSTEM / AUTOMATION — the business has operational friction software could fix.
A business with an excellent website can still be a strong lead if there is a real system opportunity. Only reject when BOTH are absent.

She needs clients who can plausibly spend $1,000-$2,000+. A business that cannot afford that is a bad lead no matter how bad its website is.

The question that matters most: "If Lucia looked at this business, would she be genuinely excited to make something for them?"

THE COMPLIMENT — "liked_thing" — is the hardest part and most models get it wrong:
- Name a CONCRETE THING. A specific product, collection, material, technique, colourway, or a detail of how they photograph or describe their work.
- GOOD: "the ash-glazed vase collection", "the way every piece is shot against raw linen", "that you name each mug after a customer"
- BAD, and rejected automatically: "aesthetic personality and unique products", "unique brand personality and values", "strong brand identity", "beautiful products". These are attribute lists. They are true of every brand and read as machine output.
- If the page does not give you a concrete thing to name, leave liked_thing empty. An empty field is fine. A generic one is not - it means no email gets sent at all.

NICHE: pick the one the BUSINESS is in, not the one describing its website quality. A ceramics studio is craft_goods. A skincare brand is beauty_wellness. Only use creative_studio for a business whose clients are other businesses - an agency or design studio.

EVIDENCE RULES — these are absolute:
- Only state things you can see in the provided page data.
- Never invent a compliment. Never invent a flaw. Never mention speed, mobile behaviour, or a collection unless the data shows it.
- If you cannot find something specific and real to admire, say so by scoring creative low. Do not fabricate.
- Quote or closely paraphrase the actual page text in "liked_evidence".

Respond with JSON only.',
  updated_at = '2026-09-09T00:00:00Z'
WHERE id = 'p-creative' AND niches IS NULL;
