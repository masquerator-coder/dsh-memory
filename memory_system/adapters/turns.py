"""Host-neutral turn traffic: what an adapter sends and receives.

The interfaces here are the *port*. Any Agent runtime can implement them; DSH
is one such runtime and its adapter lives outside this package.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Protocol, Sequence, runtime_checkable

from ..l4 import Disclosure

EventKind = Literal[
    "turn_start",
    "user_message",
    "assistant_message",
    "tool_call",
    "tool_result",
    "turn_end",
    "session_start",
    "session_end",
]


@dataclass(slots=True)
class NormalizedEvent:
    """One host event, reduced to what memory needs.

    ``seq`` must be monotonic within a session: it is the anchor ordering key.
    Everything else is optional, because a host that cannot supply it simply
    gets less provenance, never a failed write (see DESIGN.md §Anchor boundary).
    """

    kind: EventKind
    session_id: str | None = None
    agent_id: str | None = None
    seq: int | None = None
    turn: int | None = None
    step: int | None = None
    text: str | None = None
    role: str | None = None
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    tool_ok: bool | None = None
    error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def session_key(self) -> str | None:
        if not self.session_id:
            return None
        return f"{self.agent_id}:{self.session_id}" if self.agent_id else self.session_id


@dataclass(slots=True)
class TurnContext:
    """What the memory system hands back to the host for one turn."""

    project_id: str
    skills: Disclosure | None = None
    recall: Any | None = None
    soft_skill_names: list[str] = field(default_factory=list)
    tokens_estimated: int = 0

    def render(self) -> str:
        """The text an adapter injects. Empty string means inject nothing."""
        blocks: list[str] = []
        if self.skills is not None:
            rendered = self.skills.render()
            if rendered:
                blocks.append(rendered)
        if self.recall is not None and not self.recall.empty:
            lines = ["## 相关记忆"]
            for ep in getattr(self.recall, "episodes", ())[:4]:
                lines.append(f"- {ep.episode.summary}")
            for fact in getattr(self.recall, "facts", ())[:6]:
                lines.append(f"- 事实: {fact.head.name} {fact.edge.relation} {fact.tail.name}")
            if len(lines) > 1:
                blocks.append("\n".join(lines))
        return "\n\n".join(blocks)


@runtime_checkable
class TurnGateway(Protocol):
    """The port a host adapter implements; :class:`MemorySystem` satisfies the core."""

    def ensure_project(self, project_id: str, **fields: Any) -> Any: ...

    def prepare_turn(self, *, project_id: str, user_text: str, **kwargs: Any) -> Disclosure: ...

    def recall(self, query: str, *, project_id: str, **kwargs: Any) -> Any: ...

    def remember(self, *, project_id: str, summary: str, **kwargs: Any) -> dict[str, Any]: ...

    def capture_trajectory(self, *, project_id: str, steps: Sequence[Any], **kwargs: Any) -> Any: ...

    def record_skill_run(self, *, project_id: str, skill: str, outcome: str, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(slots=True)
class ProjectResolver:
    """Maps a host working directory to a stable project id.

    This exists because DSH sessions carry ``cwd`` and no project id. Two
    different checkouts of the same repository must resolve to the same project
    if they share a remote, so prefer the git remote over the path.
    """

    override: str | None = None
    org: str | None = None

    def resolve(self, cwd: str | None, *, git_remote: str | None = None) -> str:
        if self.override:
            return self.override
        if git_remote:
            return slugify_project(git_remote)
        return slugify_project(cwd or "unknown")


def slugify_project(value: str) -> str:
    import re

    text = value.strip().lower().replace("\\", "/")
    # scp-style remote: git@host:owner/repo.git -> owner/repo
    text = re.sub(r"^[a-z0-9_.-]+@[^/:]+:", "", text)
    # URL-style remote: drop scheme, credentials and host.
    text = re.sub(r"^[a-z]+://[^/]+/", "", text)
    text = re.sub(r"^[a-z0-9_.-]+@[^/]+/", "", text)
    text = re.sub(r"\.git$", "", text)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if not text:
        return "unknown"
    return text[-64:]