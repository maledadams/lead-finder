-- ---------------------------------------------------------------------------
-- The second profile: medium-sized United States businesses.
--
-- Written by hand rather than generated, because this one was specified: the
-- three categories, the trades inside them, and the fact that the emails have
-- to name the custom-coded build as the thing that distinguishes the offer.
-- POST /api/profiles is still the route for any profile after this one.
--
-- It shares nothing with the creative profile except the mailbox, the send cap,
-- the booking calendar, and dedup — a business already found by the creative
-- profile is skipped here rather than pitched twice by the same sender.
--
-- The metros are deliberately disjoint from the creative list. Overlapping
-- geography would have both profiles racing for the same OSM elements, and
-- since the first finder owns a business, the loser would simply crawl and
-- discard. Different cities means both profiles fill up.
--
-- Requires 008. Safe to re-run.
--   pnpm exec wrangler d1 execute lead-finder --remote --file=./examples/profile-medium-businesses.sql
-- ---------------------------------------------------------------------------

INSERT OR REPLACE INTO profiles
  (id, slug, name, active, is_default, brief, ai_system, niches, personas,
   seed_keywords, metros, budgets, discovery, created_at, updated_at)
VALUES (
  'p-medium',
  'medium',
  'Medium businesses',
  1,
  0,
  'Medium-sized United States businesses: healthcare and clinics, home services and trades, and logistics and warehousing. Established operators with staff and real operational load, who need a custom coded site or an internal system rather than a template.',
  'You are helping Lucia, a freelance web developer, decide which medium-sized United States businesses are worth contacting.

Lucia builds custom coded websites and internal business systems. Nothing she builds sits on Shopify, Wix, Squarespace or any website builder, so the design is not boxed in by a template and the system can do exactly what the business needs. Her clients here are established local and regional operators: clinics and private practices, home service and trade companies, and freight, warehousing and delivery companies.

A GOOD LEAD is an independent business with real revenue and real operational load — several staff, a service area or a patient list, work booked days ahead. It has a website that is dated, template-bound, hard to use on a phone, or missing the one thing its customers came for, OR it runs its intake, quoting, scheduling or dispatch on phone calls, paper and spreadsheets.

DISQUALIFYING outright: a national franchise or chain location, a marketing or SEO agency, a business whose site is plainly a lead-generation directory rather than the business itself, a sole trader with no staff and no booked work, and anything that could not plausibly spend 1,000 to 2,000 dollars or more on a build.

Evaluate the TWO service lines independently:
  A. WEBSITE — the site fails the business: dated, generic, slow to use on a phone, or it never lets a customer book, request a quote or get a straight answer.
  B. SYSTEM — the operation has friction software would remove: intake by phone only, quoting by hand, scheduling on a whiteboard, dispatch or tracking with no record a customer can see.
A business with a decent website is still a strong lead when there is a real system opportunity. Reject only when BOTH are absent.

NICHE: pick the category the BUSINESS is in, never one describing its website. A dental practice is healthcare_clinics. An HVAC contractor is home_services. A freight broker is logistics_warehousing.

EVIDENCE RULES, absolute:
- State only what the provided page data shows.
- Never invent a compliment or a flaw. Never mention speed, mobile behaviour or a service the data does not show.
- If there is nothing specific and real to point at, score low rather than fabricating.
- Quote or closely paraphrase the actual page text in any evidence field.

Respond with JSON only.',
  '{"healthcare_clinics": {"label": "Healthcare and clinics", "keywords": ["dental", "dentist", "orthodontic", "orthodontist", "endodontic", "periodontal", "dental implants", "invisalign", "hygienist", "family dentistry", "pediatric dentistry", "clinic", "physician", "primary care", "urgent care", "internal medicine", "pediatrics", "dermatology", "chiropractic", "chiropractor", "physical therapy", "physiotherapy", "rehabilitation", "podiatry", "optometry", "eye exam", "audiology", "hearing aids", "veterinary", "animal hospital", "therapist", "counseling", "psychotherapy", "mental health", "patient portal", "new patient", "insurance accepted", "request an appointment", "telehealth", "medicaid", "medicare"], "osm": {"amenity": ["dentist", "doctors", "clinic", "veterinary"], "healthcare": ["dentist", "doctor", "physiotherapist", "podiatrist", "psychotherapist", "chiropractor", "optometrist", "audiologist", "occupational_therapist", "speech_therapist", "dialysis", "midwife", "alternative"], "craft": [], "shop": ["hearing_aids", "optician", "medical_supply"], "office": []}}, "home_services": {"label": "Home services and trades", "keywords": ["plumbing", "plumber", "drain cleaning", "water heater", "sewer line", "repiping", "hvac", "heating and cooling", "air conditioning", "furnace", "heat pump", "ductwork", "electrician", "electrical contractor", "panel upgrade", "rewiring", "generator installation", "roofing", "roof replacement", "shingle", "gutters", "siding", "remodeling", "general contractor", "kitchen remodel", "bathroom remodel", "flooring", "tile installation", "painting contractor", "drywall", "landscaping", "lawn care", "irrigation", "tree service", "fencing", "decks", "garage door", "pest control", "septic", "water damage", "restoration", "free estimate", "licensed and insured", "emergency service", "service area", "financing available"], "osm": {"amenity": [], "healthcare": [], "craft": ["plumber", "electrician", "hvac", "carpenter", "roofer", "painter", "gardener", "glaziery", "stonemason", "tiler", "insulation", "window_construction", "floorer", "scaffolder", "locksmith", "metal_construction", "caterer", "chimney_sweeper", "handicraft", "sawmill"], "shop": ["doityourself", "garden_centre", "fireplace", "swimming_pool"], "office": ["construction_company"]}}, "logistics_warehousing": {"label": "Logistics and warehousing", "keywords": ["freight", "freight forwarding", "logistics", "third party logistics", "3pl", "warehousing", "warehouse", "distribution center", "fulfillment", "order fulfillment", "pick and pack", "cross docking", "trucking", "carrier", "ltl", "truckload", "flatbed", "refrigerated", "reefer", "dispatch", "drayage", "intermodal", "customs brokerage", "import export", "last mile", "courier", "same day delivery", "moving company", "movers", "self storage", "cold storage", "inventory management", "supply chain", "loading dock", "fleet", "cdl drivers", "dot number", "mc number", "request a quote", "rate quote", "shipment tracking", "proof of delivery", "bill of lading"], "osm": {"amenity": [], "healthcare": [], "craft": [], "shop": ["storage_rental"], "office": ["logistics", "courier", "forwarding", "moving_company", "storage_rental"]}}}',
  '{"healthcare_clinics": {"label": "Healthcare and clinics", "context": "I build websites and booking systems for clinics and private practices, where a new patient needs to find you, understand what you treat, and book without having to phone.", "subject": "{name} — a few notes on how patients book with you", "offer": "a short written breakdown of what I would change on the appointment pages, and why"}, "home_services": {"label": "Home services and trades", "context": "I build websites and job-request systems for home service companies, so the calls that come in are the jobs you actually want and the quoting stops eating your evenings.", "subject": "{name} — a few notes on your quote requests", "offer": "a short written breakdown of the quote-request flow with the specific changes I would make"}, "logistics_warehousing": {"label": "Logistics and warehousing", "context": "I build websites and internal systems for freight, warehousing and delivery companies — quoting, tracking, and the paperwork that follows a load around.", "subject": "{name} — a few notes on quoting and tracking", "offer": "a short written breakdown of what I would change on the quote and tracking pages"}}',
  '["dental practice", "family dentistry", "orthodontist", "pediatric dentist", "chiropractic clinic", "physical therapy clinic", "urgent care clinic", "primary care practice", "dermatology clinic", "podiatry clinic", "optometry practice", "audiology clinic", "veterinary hospital", "counseling practice", "plumbing company", "hvac company", "electrical contractor", "roofing company", "general contractor", "remodeling company", "landscaping company", "tree service company", "pest control company", "septic service", "restoration company", "garage door company", "fencing company", "flooring installer", "painting contractor", "freight forwarder", "logistics company", "third party logistics", "warehousing company", "fulfillment center", "trucking company", "courier service", "moving company", "self storage facility", "cold storage warehouse", "customs broker"]',
  '[["glendale-az", [33.52, -112.21, 33.56, -112.17]], ["mesa-az", [33.4, -111.85, 33.44, -111.81]], ["chandler-az", [33.28, -111.86, 33.32, -111.82]], ["sugar-land-tx", [29.6, -95.65, 29.64, -95.61]], ["plano-tx", [33.0, -96.72, 33.04, -96.68]], ["fort-worth-tx", [32.73, -97.35, 32.77, -97.31]], ["corpus-christi-tx", [27.78, -97.42, 27.82, -97.38]], ["el-paso-tx", [31.74, -106.51, 31.78, -106.47]], ["charlotte-nc", [35.21, -80.86, 35.25, -80.82]], ["raleigh-nc", [35.76, -78.66, 35.8, -78.62]], ["greensboro-nc", [36.05, -79.81, 36.09, -79.77]], ["tampa-fl", [27.93, -82.48, 27.97, -82.44]], ["orlando-fl", [28.52, -81.4, 28.56, -81.36]], ["jacksonville-fl", [30.31, -81.68, 30.35, -81.64]], ["fort-lauderdale-fl", [26.1, -80.16, 26.14, -80.12]], ["indianapolis-in", [39.75, -86.18, 39.79, -86.14]], ["fort-wayne-in", [41.06, -85.16, 41.1, -85.12]], ["springfield-mo", [37.19, -93.31, 37.23, -93.27]], ["omaha-ne", [41.24, -95.96, 41.28, -95.92]], ["des-moines-ia", [41.57, -93.64, 41.61, -93.6]], ["wichita-ks", [37.67, -97.36, 37.71, -97.32]], ["oklahoma-city-ok", [35.45, -97.54, 35.49, -97.5]], ["tulsa-ok", [36.13, -96.01, 36.17, -95.97]], ["las-vegas-nv", [36.15, -115.16, 36.19, -115.12]], ["henderson-nv", [36.02, -115.0, 36.06, -114.96]], ["salt-lake-city-ut", [40.74, -111.91, 40.78, -111.87]], ["spokane-wa", [47.64, -117.45, 47.68, -117.41]], ["albuquerque-nm", [35.06, -106.67, 35.1, -106.63]], ["colorado-springs-co", [38.81, -104.84, 38.85, -104.8]], ["fresno-ca", [36.72, -119.8, 36.76, -119.76]], ["bakersfield-ca", [35.35, -119.04, 35.39, -119.0]], ["riverside-ca", [33.96, -117.39, 34.0, -117.35]], ["knoxville-tn", [35.94, -83.94, 35.98, -83.9]], ["chattanooga-tn", [35.03, -85.33, 35.07, -85.29]], ["little-rock-ar", [34.73, -92.31, 34.77, -92.27]], ["baton-rouge-la", [30.43, -91.21, 30.47, -91.17]], ["toledo-oh", [41.63, -83.56, 41.67, -83.52]], ["akron-oh", [41.06, -81.54, 41.1, -81.5]], ["syracuse-ny", [43.03, -76.17, 43.07, -76.13]], ["allentown-pa", [40.58, -75.51, 40.62, -75.47]]]',
  NULL,
  NULL,
  '2026-09-08T00:00:00Z',
  '2026-09-08T00:00:00Z'
);

-- Discovery starts from these rather than waiting for the first crawl to mine
-- them, so the profile is not empty on day one.
INSERT OR IGNORE INTO keywords (profile_id, keyword, niche, source, status, added_at)
SELECT 'p-medium', value, NULL, 'profile-seed', 'UNVALIDATED', '2026-09-08T00:00:00Z'
FROM json_each('["dental practice", "family dentistry", "orthodontist", "pediatric dentist", "chiropractic clinic", "physical therapy clinic", "urgent care clinic", "primary care practice", "dermatology clinic", "podiatry clinic", "optometry practice", "audiology clinic", "veterinary hospital", "counseling practice", "plumbing company", "hvac company", "electrical contractor", "roofing company", "general contractor", "remodeling company", "landscaping company", "tree service company", "pest control company", "septic service", "restoration company", "garage door company", "fencing company", "flooring installer", "painting contractor", "freight forwarder", "logistics company", "third party logistics", "warehousing company", "fulfillment center", "trucking company", "courier service", "moving company", "self storage facility", "cold storage warehouse", "customs broker"]');
