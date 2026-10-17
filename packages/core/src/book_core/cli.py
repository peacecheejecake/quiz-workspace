"""``core`` command line (architecture.md §4). Every command is a stub until its Task lands."""

from __future__ import annotations

from typing import Any

import typer

NOT_IMPLEMENTED_EXIT_CODE = 1

app = typer.Typer(
    name="core",
    help="Quiz Workspace core: parse, chunk, index, search, excerpt, questions, eval.",
    no_args_is_help=True,
    add_completion=False,
)
questions_app = typer.Typer(
    name="questions", help="Extract or generate question drafts.", no_args_is_help=True
)
app.add_typer(questions_app)

# Accept any arguments so a stub always reports "not implemented" rather than a usage error.
_STUB_SETTINGS: dict[str, Any] = {"allow_extra_args": True, "ignore_unknown_options": True}


def _stub(group: typer.Typer, name: str, help_text: str, task: str, label: str) -> None:
    def command() -> None:
        typer.echo(f"{label}: not implemented (Task {task})", err=True)
        raise typer.Exit(code=NOT_IMPLEMENTED_EXIT_CODE)

    group.command(
        name=name,
        help=f"{help_text} [not implemented: Task {task}]",
        context_settings=_STUB_SETTINGS,
    )(command)


_stub(app, "parse", "Parse a PDF into a ParsedDocument.", "M1.5", "core parse")
_stub(app, "chunk", "Chunk a document revision into SearchChunks.", "M1.5", "core chunk")
_stub(app, "index", "Index chunks into Qdrant (dense + sparse).", "M2.6", "core index")
_stub(app, "search", "Search indexed chunks (keyword/semantic/hybrid).", "M2.6", "core search")
_stub(app, "excerpt", "Resolve a paragraph-complete excerpt for a hit.", "M2.6", "core excerpt")
_stub(app, "eval", "Run retrieval evaluation.", "M2.6", "core eval")
_stub(
    questions_app,
    "extract",
    "Extract question drafts from a question PDF.",
    "M4.3",
    "core questions extract",
)
_stub(
    questions_app,
    "generate",
    "Generate variant question drafts.",
    "M6.1",
    "core questions generate",
)


def main() -> None:
    app()
