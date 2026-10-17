"""``core`` CLI stub (P0.8): help works, every command reports "not implemented"."""

from __future__ import annotations

import shutil
import subprocess

import pytest
from book_core.cli import NOT_IMPLEMENTED_EXIT_CODE, app
from typer.testing import CliRunner

runner = CliRunner()

COMMANDS = [
    (["parse"], "M1.5"),
    (["chunk"], "M1.5"),
    (["index"], "M2.6"),
    (["search"], "M2.6"),
    (["excerpt"], "M2.6"),
    (["eval"], "M2.6"),
    (["questions", "extract"], "M4.3"),
    (["questions", "generate"], "M6.1"),
]


def test_help_lists_every_command() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for name in ("parse", "chunk", "index", "search", "excerpt", "eval", "questions"):
        assert name in result.output


def test_questions_help_lists_subcommands() -> None:
    result = runner.invoke(app, ["questions", "--help"])
    assert result.exit_code == 0
    assert "extract" in result.output
    assert "generate" in result.output


@pytest.mark.parametrize(
    ("argv", "task"), COMMANDS, ids=lambda v: " ".join(v) if isinstance(v, list) else v
)
def test_stub_commands_fail_with_not_implemented(argv: list[str], task: str) -> None:
    result = runner.invoke(app, [*argv, "input.pdf", "--some-option", "x"])
    assert result.exit_code == NOT_IMPLEMENTED_EXIT_CODE
    assert f"not implemented (Task {task})" in result.output


def test_console_script_is_installed() -> None:
    executable = shutil.which("core")
    assert executable is not None
    result = subprocess.run(  # noqa: S603
        [executable, "--help"], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0
    assert "parse" in result.stdout
