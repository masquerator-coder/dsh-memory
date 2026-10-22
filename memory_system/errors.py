"""Exception types shared by every layer."""


class MemoryError(Exception):
    """Base class for memory-system failures."""


class NotFoundError(MemoryError):
    """The requested record does not exist (or is invisible in this scope)."""


class ValidationError(MemoryError):
    """A write was rejected because its payload is structurally invalid."""


class ConflictError(MemoryError):
    """A write could not be applied under the requested conflict policy."""


class BudgetError(MemoryError):
    """A resource guard (token budget, traversal depth, capacity) was exceeded."""


class ProviderError(MemoryError):
    """A pluggable provider (embedding backend, hook source) failed."""