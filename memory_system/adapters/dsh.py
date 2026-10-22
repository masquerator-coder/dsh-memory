"""DeepSeek Harness adapter — interface stub (NOT a design deliverable).

Deliberately unimplemented. The DSH plugin is a separate piece of work; this
file records the exact binding points so the seam is unambiguous and testable.

Binding points, taken from the installed runtime (``@deepseek-ai/dsh-tools@0.2.1-rc.2``,
``dsh-session@0.2.1-rc.2``, ``dsh-skill@0.2.1-rc.2``):

Tool execution (``ToolDefinition.execute(args, exec)``)
    * ``exec.signal``            -> forward cancellation into every memory call
    * ``exec.agent``             -> the scope owner for ``ctx.tools`` restrictions
    * ``output.schema`` + ``output.render`` -> required on every registered tool

Tool pipeline hooks (waterfall / emit; all scope-filtered by agent)
    * ``tools/pre-execute``   allow | deny | cancel | ask
    * ``tools/post-execute``  accept | replace content | block
    * ``tools/result``        observe the frozen final outcome  -> skill-run telemetry
    * ``tools/change``        available-tool-set changes        -> prune skill prereqs

Session events (``ctx.on("session/event", (session, event) => ...)``)
    * ``Sequenced event object: ``{ type, seq, time, data, ignorable? }``
    * ``turn/start``, ``turn/end``, ``user/message``, ``assistant/message``,
      ``tool/call``, ``tool/result``, ``step/start``, ``step/end``
    * ``SessionHeader.cwd`` is the only project signal; there is no project id.

Agent/skill seams
    * ``ctx.on("agent/created" | "agent/disposed", ({ agent }) => ...)``
    * ``ctx.skills.register({ name, description, content, ... })`` for level-3 loading

Injection
    * ``agent.inject()`` a synthetic ``user/message`` whose ``source`` marks it as
      injected context — this is how :class:`TurnContext.render` reaches the model.

Mapping to the memory core (one-liners, for the future implementation)::

    session/event(user/message)  -> captures an L2 episode candidate
                                 -> memory.remember(...) when the turn settles
    session/event(tool/result)   -> trajectory step
    turn/end                     -> capture_trajectory(...) + record_skill_run(...)
    agent/created                -> anchors.capture(agent=..., session_id=...)
    UserPromptSubmit (inject)    -> memory.prepare_turn(...) + TurnContext.render()

Not implemented on purpose: hook wiring, tool schemas, client UI, config schema.
"""

from __future__ import annotations

from ..anchors import Anchor
from ..l4 import Disclosure
from ..system import MemorySystem
from .turns import NormalizedEvent, ProjectResolver, TurnContext

DSH_RUNTIME_VERSION = "0.2.1-rc.2"


class DshMemoryPlugin:
    """Shape of the future plugin. Every method raises: this is a seam, not code."""

    dsh_bindings = {
        "hook.session_event": "ctx.on('session/event', (session, event) => ...)",
        "hook.agent_created": "ctx.on('agent/created', ({ agent }) => ...)",
        "hook.tools_result": "ctx.on('tools/result', (exec, result) => ...)",
        "hook.turn_inject": "agent.inject(<user/message with source=memory>)",
        "tool.register": "ctx.tools.register(defineTool({ name, parameters, output, execute }))",
        "skill.register": "ctx.skills.register({ name, description, content })",
    }

    def __init__(self, memory: MemorySystem, resolver: ProjectResolver | None = None) -> None:
        self.memory = memory
        self.resolver = resolver or ProjectResolver()

    def apply(self, ctx: object, config: object | None = None) -> None:  # pragma: no cover
        raise NotImplementedError(
            "The DSH plugin is out of scope for this deliverable. See "
            "memory_system/adapters/turns.py for the port it must implement."
        )

    # ── the transformations the plugin will perform ──────────────────────
    def project_id_for(self, cwd: str | None, git_remote: str | None = None) -> str:
        return self.resolver.resolve(cwd, git_remote=git_remote)

    def to_normalized(self, event_type: str, data: dict, *, session_id: str | None,
                      agent_id: str | None, seq: int | None) -> NormalizedEvent | None:  # pragma: no cover
        """Map a DSH ``SessionEvent`` onto :class:`NormalizedEvent`."""
        raise NotImplementedError

    def to_anchor(self, event: NormalizedEvent) -> Anchor | None:  # pragma: no cover
        raise NotImplementedError

    def build_turn_context(
        self,
        *,
        project_id: str,
        user_text: str,
        available_tools: list[str],
        session_key: str | None,
        turn: int | None,
        recall_query: str | None = None,
    ) -> TurnContext:
        """The one transformation that is fully specified by this package."""
        disclosure: Disclosure = self.memory.prepare_turn(
            project_id=project_id,
            user_text=user_text,
            available_tools=available_tools,
            session_key=session_key,
            turn=turn,
        )
        recall = (
            self.memory.recall(recall_query, project_id=project_id, mode="auto")
            if recall_query
            else None
        )
        return TurnContext(
            project_id=project_id,
            skills=disclosure,
            recall=recall,
            soft_skill_names=list(disclosure.soft),
            tokens_estimated=disclosure.tokens_total,
        )