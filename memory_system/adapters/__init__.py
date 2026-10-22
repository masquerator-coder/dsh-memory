"""DSH bindings: protocol + adapter stubs only.

Per the brief, the DSH plugin is **not** designed here. What this package fixes
is the seam, in the two directions DSH actually needs it:

1. **What the memory system emits** — :class:`TurnContext`, a plain description
   of one turn's L4 disclosure plus optional L2/L3 grounding. The adapter turns
   that into a DSH ``user/message`` *injected context* (``agent.inject()``),
   which DSH's session docs describe as a synthetic ``user-role`` message whose
   ``source`` distinguishes it from the human prompt.

2. **What the memory system consumes** — a small set of normalized events
   (``turn_start``, ``user_message``, ``tool_result``, ``turn_end``). The
   adapter maps DSH's real events onto them; the memory core never imports
   ``@deepseek-ai/*``.

The actual DSH plugin must:
* subscribe with ``ctx.on("session/event", ...)`` / ``ctx.on("agent/created", ...)``;
* register tools with ``ctx.tools.register(defineTool({...}))``;
* expose skills via ``ctx.skills.register(...)`` if level-3 loading should look
  native;
* resolve ``project_id`` itself (DSH sessions carry ``cwd``, not a project id —
  see DESIGN.md D1).

None of that is implemented here.
"""

from .turns import NormalizedEvent, TurnContext, TurnGateway

__all__ = ["NormalizedEvent", "TurnContext", "TurnGateway"]