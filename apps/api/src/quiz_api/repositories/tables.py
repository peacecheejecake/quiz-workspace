"""SQLAlchemy Core descriptions of the tables the API reads (subset of the columns).

These mirror `supabase/migrations`; they are never used to create or alter the schema.
"""

from __future__ import annotations

from sqlalchemy import Column, DateTime, MetaData, Table, Text, Uuid

metadata = MetaData(schema="public")

profiles = Table(
    "profiles",
    metadata,
    Column("user_id", Uuid, primary_key=True),
    Column("display_name", Text),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

workspaces = Table(
    "workspaces",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("name", Text, nullable=False),
    Column("owner_id", Uuid, nullable=False),
    Column("status", Text, nullable=False),
    Column("archived_at", DateTime(timezone=True)),
    Column("deleted_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

workspace_memberships = Table(
    "workspace_memberships",
    metadata,
    Column("workspace_id", Uuid, primary_key=True),
    Column("user_id", Uuid, primary_key=True),
    Column("role", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)
