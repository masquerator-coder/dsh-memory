"""Configuration for the whole memory system.

Every numeric guard in the design document is a field here so an embedder can
tune behaviour without editing code. Defaults follow the design document where
it is explicit; where this implementation had to choose (see
``docs/DESIGN.md`` §'Divergences') the choice is recorded next to the field.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

Clock = Literal["utc", "local"]


@dataclass(slots=True)
class EmbeddingConfig:
    """Which embedding backend to use and how to size vectors.

    ``provider="hash"`` is the dependency-free default: deterministic feature
    hashing over character n-grams. It gives real lexical-semantic locality for
    a small corpus but is **not** a semantic model. Production deployments
    should point ``provider="http"`` at a real embedding service so that
    ``cosine_similarity`` means what L2/L3 scoring assumes it means.

    ``preset="qwen3"`` fills in the recommended production endpoint
    (Qwen3-Embedding-0.6B, 1024 dims) so the common case is one line.
    """

    provider: Literal["hash", "http", "callable"] = "hash"
    dim: int = 256
    # Named endpoint preset; when set it overrides provider/url/model/dim.
    preset: Literal["qwen3", "bge-m3", "nomic-embed-text"] | None = None
    # --- hash backend ---
    hash_ngram: tuple[int, ...] = (1, 2, 3)
    # --- http backend ---
    http_url: str | None = None
    http_model: str | None = None
    http_api_key: str | None = None
    http_timeout_s: float = 20.0
    http_batch: int = 64
    # Startup probe. "warn" logs and continues, "raise" refuses to open,
    # "fallback" silently degrades to the hash backend (data must then be
    # re-embedded later — only sane for a fresh database).
    on_unavailable: Literal["warn", "raise", "fallback"] = "warn"
    # Normalize every vector to unit length so cosine == dot product.
    normalize: bool = True

    def with_preset(self) -> "EmbeddingConfig":
        """Return a copy with a named preset applied."""
        if not self.preset:
            return self
        spec = EMBEDDING_PRESETS.get(self.preset)
        if spec is None:
            raise ValueError(f"unknown embedding preset: {self.preset}")
        out = dataclasses.replace(self)
        out.provider = "http"
        out.http_url = self.http_url or spec["url"]
        out.http_model = self.http_model or spec["model"]
        out.dim = spec["dim"] if self.dim in (0, 256) else self.dim
        return out


# Recommended endpoints. All are OpenAI-compatible, so they work through the
# same HttpEmbedding client (Ollama, vLLM, LM Studio, TEI, … all speak it).
EMBEDDING_PRESETS: dict[str, dict] = {
    # Best quality/size tradeoff for mixed CJK+English coding memory:
    # 1024 dims, 32K context, strong multilingual and code retrieval.
    "qwen3": {
        "url": "http://localhost:11434/v1/embeddings",
        "model": "qwen3-embedding:0.6b",
        "dim": 1024,
    },
    # Solid multilingual all-rounder; slightly weaker than Qwen3-Embedding.
    "bge-m3": {
        "url": "http://localhost:11434/v1/embeddings",
        "model": "bge-m3",
        "dim": 1024,
    },
    # Small and fast, English-heavy; weakest for Chinese content.
    "nomic-embed-text": {
        "url": "http://localhost:11434/v1/embeddings",
        "model": "nomic-embed-text",
        "dim": 768,
    },
}


@dataclass(slots=True)
class LexicalConfig:
    """Tokenizer used by the FTS5 lexical index and by intent matching."""

    tokenizer: Literal["auto", "unicode", "jieba"] = "auto"
    # Terms longer than this are dropped (they behave like stopwords in FTS).
    max_term_len: int = 24


@dataclass(slots=True)
class L2Config:
    """Episodic memory: exponential forgetting with access reinforcement."""

    # S = base_stability_hours * importance * (1 + beta * ln(1 + access_count))
    base_stability_hours: float = 24.0
    beta: float = 0.5
    # Retention of a freshly written memory at importance 1.0, access 0:
    # exp(-0/24) = 1.0; at 24h it is exp(-1) ≈ 0.368.
    active_threshold: float = 0.30
    dormant_threshold: float = 0.05
    # final_score = similarity * (floor + (1 - floor) * retention)
    retention_floor: float = 0.20
    # Hard floor on `importance` accepted from a model; 0 would mean an
    # infallible-in-one-day memory, which is never what a model intends.
    min_importance: float = 0.05
    default_importance: float = 0.5
    # Retrieval touches every returned row's access counters (spacing effect).
    reinforce_on_retrieve: bool = True
    default_include_dormant: bool = False
    # Below this blended similarity a candidate is dropped before re-ranking:
    # multiplying a near-zero similarity by a high retention would otherwise
    # promote irrelevant-but-fresh rows.
    min_similarity: float = 0.12
    # Near-duplicate suppression on the write path.
    dedup_similarity: float = 0.95
    candidate_limit: int = 32


@dataclass(slots=True)
class RelationTypeSpec:
    """Consistency metadata registered for one relation type."""

    name: str
    cardinality: Literal["one", "many"] = "many"
    domain: tuple[str, ...] | None = None  # allowed head entity types; None = any
    range: tuple[str, ...] | None = None  # allowed tail entity types; None = any
    # Causal/hierarchical relations are checked for cycles.
    acyclic: bool = False
    inverse: str | None = None
    # Edge weight multiplier for graph traversal (1.0 = neutral).
    weight: float = 1.0
    description: str = ""


@dataclass(slots=True)
class L3Config:
    """Semantic graph: constraints, conflict resolution, retrieval."""

    relation_types: tuple[RelationTypeSpec, ...] = (
        RelationTypeSpec("is_a", cardinality="many", acyclic=True, weight=0.9,
                         description="subsumption; head is a kind of tail"),
        RelationTypeSpec("part_of", cardinality="many", acyclic=True, weight=0.9,
                         description="mereological containment"),
        RelationTypeSpec("causes", cardinality="many", acyclic=True, weight=0.8),
        RelationTypeSpec("depends_on", cardinality="many", acyclic=True, weight=0.8),
        RelationTypeSpec("owns", cardinality="one", weight=1.0),
        RelationTypeSpec("located_in", cardinality="one", weight=1.0),
        RelationTypeSpec("works_at", cardinality="one", weight=1.0),
        RelationTypeSpec("uses", cardinality="many", weight=1.0),
        RelationTypeSpec("related_to", cardinality="many", weight=0.6),
        RelationTypeSpec("contradicts", cardinality="many", weight=0.5),
    )
    # Unknown relation names are rejected unless this is on.
    allow_unknown_relations: bool = False
    # Conflict policy used when a write does not specify one.
    #   evidence : resolve by evidence strength (default)
    #   last_write : newest recorded_at wins
    #   defer : record both, mark both tail edges `disputed`
    default_conflict_policy: Literal["evidence", "last_write", "defer"] = "evidence"
    # Minimum confidence for an edge to be written at all.
    min_confidence: float = 0.0
    # --- fast path ---
    fast_seed_k: int = 8
    # Below this cosine an entity is not a seed at all (0 would admit
    # orthogonal-but-unrelated nodes and flood the expansion with noise).
    min_seed_similarity: float = 0.08
    fast_max_hops: int = 2
    fast_hop_decay: float = 0.55
    fast_max_nodes: int = 400
    fast_timeout_ms: int = 200
    # --- deep path ---
    deep_max_hops: int = 3  # hard ceiling from the design document
    deep_ppr_alpha: float = 0.15  # restart probability
    deep_ppr_iterations: int = 24
    deep_ppr_max_nodes: int = 400
    deep_top_k: int = 20
    deep_timeout_ms: int = 2000
    deep_max_rewrites: int = 2  # design allows <=4; 2 keeps the budget honest
    deep_token_budget: int = 2400
    # --- fusion ---
    rrf_k: int = 60
    # Edge types that are always traversable (precondition for the whitelist).
    traversal_edge_allowlist: tuple[str, ...] | None = None  # None = all
    # Community detection + summarization thresholds.
    community_min_size: int = 3
    community_max_size: int = 60


@dataclass(slots=True)
class L4Config:
    """Procedural memory: scopes, tiers, maturity, attention budget."""

    # --- capacity ---
    max_active_per_project: int = 200
    max_candidates_per_project: int = 50
    max_skills_global: int = 2000
    # --- tiers ---
    hot_tier_limit: int = 20
    hot_min_executions_30d: int = 3
    # --- maturity (all five must hold) ---
    maturity_min_successes: int = 3
    maturity_min_success_rate: float = 0.80
    maturity_min_sessions: int = 2
    maturity_min_step_consistency: float = 0.70
    maturity_require_preconditions: bool = True
    # --- merge ---
    merge_similarity: float = 0.85
    # --- retirement ---
    retire_unused_days: int = 180
    retire_window_runs: int = 10
    retire_success_rate: float = 0.50
    # --- matching ---
    match_intent_weight: float = 0.40
    match_prereq_weight: float = 0.30
    match_semantic_weight: float = 0.20
    match_success_weight: float = 0.10
    match_candidate_limit: int = 12
    match_min_score: float = 0.25
    # --- attention budget (tokens) ---
    index_budget_tokens: int = 500
    detail_budget_tokens: int = 800
    definition_budget_tokens: int = 2000
    turn_budget_tokens: int = 3300
    detail_max_skills: int = 2
    # --- promotion ---
    promotion_max_daily: int = 5
    promotion_expiry_days: int = 90
    promotion_reject_cooldown_days: int = 180
    promotion_cross_project_similarity: float = 0.85
    promotion_single_project_runs: int = 20
    promotion_single_project_success_rate: float = 0.90
    # --- archive ---
    archive_hot_days: int = 90
    archive_warm_days: int = 365
    archive_reference_similarity: float = 0.85
    archive_similar_similarity: float = 0.60


@dataclass(slots=True)
class MaintenanceConfig:
    """Background cadence, expressed as attempts per `Maintenance.run_once`."""

    decay_interval_s: int = 3600
    consolidation_interval_s: int = 3600
    community_interval_s: int = 21600
    archive_scan_interval_s: int = 86400
    promotion_scan_interval_s: int = 3600


@dataclass(slots=True)
class MemoryConfig:
    """Top-level configuration."""

    db_path: Path | str = ":memory:"
    embedding: EmbeddingConfig = field(default_factory=EmbeddingConfig)
    lexical: LexicalConfig = field(default_factory=LexicalConfig)
    l2: L2Config = field(default_factory=L2Config)
    l3: L3Config = field(default_factory=L3Config)
    l4: L4Config = field(default_factory=L4Config)
    maintenance: MaintenanceConfig = field(default_factory=MaintenanceConfig)
    # Scope weights: project rows are twice as expensive to share across projects.
    cross_project_decay: float = 0.5
    clock: Clock = "utc"
    # WAL is right for a long-lived plugin process; off for :memory:.
    journal_mode: str = "WAL"
    # How many versions of an entity's mutable attributes to retain.
    attribute_history_limit: int = 20

    @classmethod
    def for_home(cls, home: Path | str, **overrides) -> "MemoryConfig":
        """Convenience: store one SQLite file under ``home``.

        Accepts ``embedding_preset=`` for the common case::

            MemoryConfig.for_home("~/.dsh/memory", embedding_preset="qwen3")
        """
        home = Path(home)
        home.mkdir(parents=True, exist_ok=True)
        preset = overrides.pop("embedding_preset", None)
        config = cls(db_path=home / "memory.db", **overrides)
        if preset:
            config.embedding.preset = preset
            applied = config.embedding.with_preset()
            config.embedding = applied
        return config

    def relation_spec(self, name: str) -> RelationTypeSpec | None:
        for spec in self.l3.relation_types:
            if spec.name == name:
                return spec
        return None

    def with_(self, **overrides) -> "MemoryConfig":
        """Return a copy with shallow-branch replacements for named config groups.

        ``config.with_(l2=L2Config(dedup_similarity=0.9))`` keeps everything else.
        """
        kwargs = {k: v for k, v in overrides.items() if hasattr(self, k)}
        return dataclasses.replace(self, **kwargs)