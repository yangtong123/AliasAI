# AliasAI Entity Resolution v1

## Goal

Entity Resolution decides whether a newly detected Mention refers to an existing Matter-scoped Entity.

The system is designed for legal/privacy workflows where false merges are more dangerous than false splits.

Primary rule:

```text
Precision over recall.
Prefer false split over false merge.
```

## Pipeline

```text
Mention
  |
  v
Normalization
  |
  v
Strong Identifier Lookup
  |
  v
Candidate Generation
  |
  v
Hard Constraint Check
  |-- Cannot-Link -> reject
  `-- Must-Link   -> auto-link
  |
  v
Feature Extraction
  |
  v
Evidence Scoring
  |
  v
Candidate Ranking
  |
  v
Top1 / Top2 Margin Check
  |
  +-- AUTO_LINK
  +-- REVIEW
  `-- NEW_ENTITY / UNRESOLVED
```

## Mention Strength

Mentions are classified as:

- `EXPLICIT`: full name/company/full identifier
- `PARTIAL`: partial name or shortened company name
- `REFERENCE`: role/reference such as `原告`, `该公司`, `张先生`

Rules:

- EXPLICIT may generate a new canonical Entity.
- PARTIAL may generate candidates but requires stronger contextual evidence.
- REFERENCE should normally resolve to an existing Entity or remain unresolved; do not create a canonical Entity from a weak reference by default.

## Normalization

Normalization is used only for matching. It must not overwrite source text.

### Common normalization

- Unicode NFKC
- normalize whitespace
- normalize punctuation
- normalize full-width/half-width characters
- trim formatting noise

### Phone

Example:

```text
+86 138-0013-8000 -> 13800138000
```

### Person

Preserve semantic structure rather than guessing:

```text
张先生
=> surname=张, givenName=null, honorific=先生
```

Do not normalize `张先生` directly into a particular full name.

### Organization

Parse useful components when possible:

```text
深圳市星河科技有限公司
=> region=深圳
=> coreName=星河
=> industry=科技
=> suffix=有限公司
```

Core name is more informative than legal suffix, but regional/registration evidence must prevent unsafe merges.

## OCR-aware Similarity

Maintain an OCR confusion model separately from normal string similarity.

Examples:

- `0/O/○`
- `1/I/l`
- `8/B`
- common Chinese glyph confusions observed in benchmark data

Use both:

- standard string/edit similarity
- OCR-aware edit similarity

OCR similarity is supporting evidence only. It must not independently trigger an auto-link.

## Strong Identifier Lookup

For protected values with stable normalized forms, perform Matter-scoped fingerprint lookup before fuzzy matching.

Fingerprint:

```text
HMAC-SHA256(matter_search_key, normalized_value)
```

Examples:

- ID card
- passport
- unified social credit code
- phone
- email
- bank account

Hard identity fields may create Must-Link or Cannot-Link decisions depending on type and conflict semantics.

## Candidate Generation

Do not compare each Mention against every Entity.

Maintain Matter-local in-memory indexes while a Matter is open, such as:

- `PersonNameIndex`
- `OrganizationNameIndex`
- `PhoneIndex`
- `IdCardIndex`
- `EmailIndex`
- `RoleIndex`
- `OrganizationMemberIndex`

### PERSON candidate blocks

Candidate sources may include:

- exact normalized name
- matching surname for partial mention
- shared strong identifier
- shared organization
- compatible role
- known Matter-local surface form
- OCR-similar explicit name

### ORGANIZATION candidate blocks

Candidate sources may include:

- exact registered name
- core-name match
- registered identifier
- address/legal representative context
- Matter-local known short name

## Evidence Classes

Evidence is classified by semantic strength.

### HARD_IDENTITY

Examples:

- same valid ID card
- same passport identifier
- same unified social credit code

### HARD_CONFLICT

Examples:

- conflicting valid ID cards for PERSON
- conflicting unified social credit codes for ORGANIZATION
- explicit user Cannot-Link

### STRONG

Examples:

- same phone
- same email
- same bank account

These are strong evidence but are not always globally unique in real life.

### SUPPORTING

Examples:

- exact name
- OCR-aware name similarity
- same organization
- same address
- compatible job title

### WEAK

Examples:

- same role
- same document
- close page position
- generic reference compatibility

## PERSON Feature Set v1

Suggested features:

- `name_exact`
- `name_similarity`
- `ocr_name_similarity`
- `surname_match`
- `phone_match`
- `email_match`
- `id_card_match`
- `organization_overlap`
- `role_compatibility`
- `address_similarity`
- `same_document`
- `context_overlap`
- `temporal_consistency`

Conflict features:

- `id_card_conflict`
- `passport_conflict`
- user-defined Cannot-Link

## ORGANIZATION Feature Set v1

Suggested features:

- `registered_name_exact`
- `core_name_similarity`
- `industry_similarity`
- `region_match`
- `unified_credit_code_match`
- `registered_address_similarity`
- `legal_representative_overlap`
- `context_overlap`

Conflict features:

- `unified_credit_code_conflict`
- user-defined Cannot-Link

## Hard Rules

Evaluation order:

```text
1. explicit Cannot-Link
2. hard identity conflict
3. hard Must-Link
4. soft scoring
```

A machine-learning score must never override a hard conflict.

### Example Cannot-Link

```text
张伟 + ID_CARD=A
张伟 + ID_CARD=B
A != B
=> CANNOT_LINK
```

### Example Must-Link

```text
PERSON mention + same validated ID_CARD as Entity
=> MUST_LINK
```

For shared values such as phone numbers, use strong evidence rather than unconditional Must-Link unless additional rules justify it.

## Scoring v1

V1 uses explainable weighted evidence plus rule gates, not an opaque model.

Illustrative PERSON weights only; benchmark data must calibrate production values:

```text
name exact                  +25
OCR-aware name similarity   +15
phone exact                 +40
email exact                 +40
same organization           +15
role compatible             +10
address similarity          +10
context overlap             +10
```

Do not treat these illustrative values as immutable constants. Version the algorithm configuration.

## Decision Logic

Initial V1 thresholds may be:

```text
Hard Cannot-Link
=> REJECT

Hard Must-Link
=> AUTO_LINK

Top1 >= 90 and (Top1 - Top2) >= 15
=> AUTO_LINK

Top1 >= 65
=> REVIEW

Top1 < 65
=> NEW_ENTITY for sufficiently explicit mentions
```

For REFERENCE mentions, low score should usually produce `UNRESOLVED`, not a new Entity.

Thresholds must be benchmark-calibrated before production claims.

## Why Top1/Top2 Margin Matters

Example safe candidate ranking:

```text
E1 = 92
E2 = 30
```

Example ambiguous ranking:

```text
E1 = 93
E2 = 90
```

Even though E1 exceeds the nominal auto-link score, the second case requires human review.

## Context Extraction

Use a bounded local context rather than the entire page for routine matching.

Initial text window:

```text
100-200 characters before Mention
+ Mention
+ 100-200 characters after Mention
```

Extract structured evidence where possible:

- organization
- role
- phone
- address
- job title
- related named entities

V1 should prefer structured overlap over embedding-only similarity.

## Human Review

Review UI should show:

- Mention text
- best candidate Entity/Alias
- confidence/evidence score
- evidence list
- conflicts
- alternative candidates when material

Actions:

- same entity
- not same entity
- leave unresolved
- create new entity

User decisions create ResolutionEvents and can create Matter-local surface forms/constraints.

## Feedback Recording

Record enough information for future supervised model training:

- feature vector
- rule/evidence result
- candidate ranking
- system recommendation
- user decision
- algorithm version

Do not store raw decrypted protected values in analytics/debug logs.

## V2 Model Path

Only after sufficient reviewed examples exist, consider replacing the soft scorer with:

- logistic regression
- LightGBM/gradient boosting

Hard rules remain outside and above the model.

Embeddings may later contribute a `context_embedding_similarity` feature, but should not become the sole identity decision mechanism.

## Evaluation Metrics

Track at least:

- Auto-Link Precision
- False Merge Rate
- False Split Rate
- Human Review Rate
- Unresolved Rate

Primary safety metric:

```text
False Merge Rate
```

The product may prefer lower automation coverage if that yields materially higher Auto-Link Precision.