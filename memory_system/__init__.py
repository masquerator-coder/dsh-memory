"""memory-system — a layered memory system for coding agents.

Public surface, by layer:

* :class:`MemorySystem` — the facade a host adapter talks to.
* L2 :class:`EpisodicMemory` — episodic recall with Ebbinghaus decay.
* L3 :class:`SemanticMemory` — knowledge graph with write-time consistency,
  dual temporality, and evidence-based belief retraction; :class:`Retriever`
  adds fast/deep recall.
* L4 :class:`SkillRegistry` — scoped, maturity-gated procedural memory under an
  attention budget, with a backup archive and user-decided promotion.

L0 (:class:`AnchorRegistry`) is a fixed interface only: pointers, never text.
"""

from .anchors import Anchor, AnchorRegistry, AnchorSource
from .cache import EmbeddingCache
from .config import (
    EMBEDDING_PRESETS,
    EmbeddingConfig,
    L2Config,
    L3Config,
    L4Config,
    LexicalConfig,
    MaintenanceConfig,
    MemoryConfig,
    RelationTypeSpec,
)
from .embedding import (
    EmbeddingProvider,
    HashEmbedding,
    HttpEmbedding,
    ProbeResult,
    build_checked_provider,
    build_provider,
    cosine_similarity,
    probe_provider,
)
from .errors import (
    BudgetError,
    ConflictError,
    MemoryError,
    NotFoundError,
    ProviderError,
    ValidationError,
)
from .l2 import Episode, EpisodeHit, EpisodicMemory, Retention
from .l3 import Edge, Entity, FactInput, SemanticMemory
from .l4 import Disclosure, ScopeView, Skill, SkillDefinition, Step
from .maturity import MaturityEvidence, Trajectory, TrajectoryStep
from .retrieval import RoutePlan, SearchOptions, SearchResult, route_query
from .skills import CapacityError, SkillContext, SkillMatch, SkillRegistry
from .summary import (
    LENGTH_PRESETS,
    PROMPT_VERSION,
    DigestRecord,
    DigestRequest,
    DigestService,
    MemoryNotepad,
    MemoryView,
    SummarySettings,
    export_markdown,
)
from .system import MemorySystem, ProjectInfo

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # facade
    "MemorySystem",
    "ProjectInfo",
    "MemoryConfig",
    "EmbeddingConfig",
    "LexicalConfig",
    "L2Config",
    "L3Config",
    "L4Config",
    "MaintenanceConfig",
    "RelationTypeSpec",
    # L0
    "Anchor",
    "AnchorRegistry",
    "AnchorSource",
    # L2
    "EpisodicMemory",
    "Episode",
    "EpisodeHit",
    "Retention",
    # L3
    "SemanticMemory",
    "Entity",
    "Edge",
    "FactInput",
    "SearchOptions",
    "SearchResult",
    "RoutePlan",
    "route_query",
    # L4
    "SkillRegistry",
    "Skill",
    "SkillDefinition",
    "Step",
    "SkillMatch",
    "SkillContext",
    "Disclosure",
    "ScopeView",
    "CapacityError",
    "Trajectory",
    "TrajectoryStep",
    "MaturityEvidence",
    # digest / profile notepad (host prompt surface)
    "DigestService",
    "DigestRequest",
    "DigestRecord",
    "SummarySettings",
    "MemoryNotepad",
    "MemoryView",
    "LENGTH_PRESETS",
    "PROMPT_VERSION",
    "export_markdown",
    # providers
    "EmbeddingProvider",
    "EmbeddingCache",
    "HashEmbedding",
    "HttpEmbedding",
    "ProbeResult",
    "EMBEDDING_PRESETS",
    "build_provider",
    "build_checked_provider",
    "probe_provider",
    "cosine_similarity",
    # errors
    "MemoryError",
    "NotFoundError",
    "ValidationError",
    "ConflictError",
    "BudgetError",
    "ProviderError",
]