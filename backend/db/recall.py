# pyright: reportArgumentType=false, reportAttributeAccessIssue=false, reportCallIssue=false

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional, TYPE_CHECKING

import httpx
from sqlalchemy import select, delete, text
from sqlalchemy.ext.asyncio import AsyncSession

from .models import SearchDocument, GlossaryKeyword, SessionReadNode, vector_literal

if TYPE_CHECKING:
    from .database import DatabaseManager


_QUERY_TOKEN_RE = re.compile(r"[A-Za-z0-9_./+-]{2,}|[\u4e00-\u9fff]{1,6}")
_EXACT_DISCLOSURE_TOKENS = [
    "偏好", "规则", "项目", "微信", "browser", "OpenClaw", "Nocturne", "回滚",
    "字幕", "HLTV", "CLI", "opencode", "前置召回", "记忆系统", "Memory Explorer",
]


@dataclass
class RecallEmbeddingConfig:
    base_url: str
    api_key: str
    model: str
    timeout_ms: int = 45000


class RecallService:
    """Semantic recall index + session read tracking for Nocturne."""

    def __init__(self, db: "DatabaseManager"):
        self._session = db.session
        self._optional_session = db._optional_session

    @staticmethod
    def _parse_glossary_json(raw: str | None) -> list[str]:
        if not raw:
            return []
        try:
            data = json.loads(raw)
            return [str(x) for x in data if str(x).strip()]
        except Exception:
            return []

    @staticmethod
    def _truncate(text_value: str | None, max_chars: int) -> str:
        value = (text_value or "").strip()
        return value if len(value) <= max_chars else value[:max_chars] + "…"

    @staticmethod
    def _hash_payload(payload: dict[str, Any]) -> str:
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def _path_name(path: str) -> str:
        return path.split("/")[-1] if path else "root"

    @staticmethod
    def _dedupe_terms(values: list[str], *, max_items: int) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for item in values:
            text_value = str(item or "").strip()
            key = text_value.casefold()
            if not text_value or key in seen:
                continue
            seen.add(key)
            out.append(text_value)
            if len(out) >= max_items:
                break
        return out

    @classmethod
    def _build_embedding_text(cls, doc: dict[str, Any]) -> str:
        path_tokens = [token for token in re.split(r"[/_\-\s]+", doc.get("path") or "") if len(token) >= 2]
        name_tokens = [token for token in re.split(r"[/_\-\s]+", doc.get("name") or "") if token]
        glossary = [str(item) for item in (doc.get("glossary_keywords") or [])]
        disclosure = cls._truncate(doc.get("disclosure"), 120)
        trigger_terms = cls._dedupe_terms(glossary + name_tokens + path_tokens, max_items=8)

        parts = [
            f"URI: {doc['uri']}",
            f"Name: {doc['name']}",
        ]
        if trigger_terms:
            parts.append("Triggers: " + ", ".join(trigger_terms))
        if disclosure:
            parts.append(f"Hint: {disclosure}")
        return "\n".join(parts)

    @classmethod
    def _build_cue_text(cls, doc: dict[str, Any]) -> str:
        glossary = [str(item) for item in (doc.get("glossary_keywords") or [])]
        name = doc.get("name") or ""
        name_tokens = [token for token in re.split(r"[/_\-\s]+", name) if token]
        path_tokens = [token for token in re.split(r"[/_\-\s]+", doc.get("path") or "") if len(token) >= 2]
        disclosure = cls._truncate(doc.get("disclosure"), 80)
        parts = cls._dedupe_terms(glossary + name_tokens + path_tokens + ([disclosure] if disclosure else []), max_items=6)
        return " · ".join(parts)

    @staticmethod
    def _tokenize_query(query: str) -> list[str]:
        tokens = [m.group(0).strip() for m in _QUERY_TOKEN_RE.finditer(query or "")]
        out: list[str] = []
        seen: set[str] = set()
        for token in tokens:
            key = token.casefold()
            if not token or key in seen:
                continue
            seen.add(key)
            out.append(token)
        return out

    async def _embed_texts(self, cfg: RecallEmbeddingConfig, inputs: list[str]) -> list[list[float]]:
        if not inputs:
            return []
        headers = {
            "Authorization": f"Bearer {cfg.api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        out: list[list[float]] = []
        async with httpx.AsyncClient(timeout=cfg.timeout_ms / 1000) as client:
            for text_value in inputs:
                resp = await client.post(
                    f"{cfg.base_url.rstrip('/')}/embeddings",
                    headers=headers,
                    json={"model": cfg.model, "input": text_value},
                )
                resp.raise_for_status()
                data = resp.json()
                rows = sorted(data.get("data") or [], key=lambda x: x.get("index", 0))
                if not rows:
                    raise RuntimeError("Embedding response missing data rows")
                out.append(rows[0]["embedding"])
        return out

    async def _load_source_documents(self, session: AsyncSession) -> list[dict[str, Any]]:
        rows = (
            await session.execute(
                select(
                    SearchDocument.domain,
                    SearchDocument.path,
                    SearchDocument.node_uuid,
                    SearchDocument.memory_id,
                    SearchDocument.uri,
                    SearchDocument.content,
                    SearchDocument.disclosure,
                    SearchDocument.priority,
                ).order_by(SearchDocument.domain, SearchDocument.path)
            )
        ).all()
        if not rows:
            return []

        glossary_rows = (
            await session.execute(
                select(GlossaryKeyword.node_uuid, GlossaryKeyword.keyword)
                .order_by(GlossaryKeyword.node_uuid, GlossaryKeyword.keyword)
            )
        ).all()
        glossary_map: dict[str, list[str]] = {}
        for node_uuid, keyword in glossary_rows:
            glossary_map.setdefault(node_uuid, []).append(keyword)

        docs: list[dict[str, Any]] = []
        for row in rows:
            body_preview = self._truncate(row.content, 900)
            glossary_keywords = glossary_map.get(row.node_uuid, [])
            doc = {
                "domain": row.domain,
                "path": row.path,
                "node_uuid": row.node_uuid,
                "memory_id": row.memory_id,
                "uri": row.uri,
                "name": self._path_name(row.path),
                "priority": row.priority,
                "disclosure": row.disclosure or "",
                "glossary_keywords": glossary_keywords,
                "body_preview": body_preview,
            }
            doc["cue_text"] = self._build_cue_text(doc)
            doc["embedding_text"] = self._build_embedding_text(doc)
            doc["source_signature"] = self._hash_payload(
                {
                    "uri": doc["uri"],
                    "memory_id": doc["memory_id"],
                    "priority": doc["priority"],
                    "disclosure": doc["disclosure"],
                    "glossary_keywords": doc["glossary_keywords"],
                    "body_preview": doc["body_preview"],
                    "embedding_text": doc["embedding_text"],
                }
            )
            docs.append(doc)
        return docs

    async def ensure_index(
        self,
        embedding: RecallEmbeddingConfig,
        session: Optional[AsyncSession] = None,
    ) -> dict[str, int]:
        async with self._optional_session(session) as session:
            source_docs = await self._load_source_documents(session)
            existing_rows = (
                await session.execute(
                    text(
                        """
                        SELECT domain, path, source_signature
                        FROM recall_documents
                        """
                    )
                )
            ).mappings().all()
            existing_map = {(row["domain"], row["path"]): row for row in existing_rows}
            source_map = {(doc["domain"], doc["path"]): doc for doc in source_docs}

            stale: list[dict[str, Any]] = []
            for key, doc in source_map.items():
                row = existing_map.get(key)
                if not row or row["source_signature"] != doc["source_signature"]:
                    stale.append(doc)

            if stale:
                vectors = await self._embed_texts(embedding, [doc["embedding_text"] for doc in stale])
                for doc, vector in zip(stale, vectors):
                    await session.execute(
                        text(
                            """
                            INSERT INTO recall_documents (
                                domain,
                                path,
                                node_uuid,
                                memory_id,
                                uri,
                                name,
                                priority,
                                disclosure,
                                glossary_json,
                                cue_text,
                                body_preview,
                                embedding_text,
                                embedding_model,
                                embedding_dim,
                                embedding_vector,
                                source_signature,
                                updated_at
                            ) VALUES (
                                :domain,
                                :path,
                                :node_uuid,
                                :memory_id,
                                :uri,
                                :name,
                                :priority,
                                :disclosure,
                                :glossary_json,
                                :cue_text,
                                :body_preview,
                                :embedding_text,
                                :embedding_model,
                                :embedding_dim,
                                CAST(:embedding_vector AS vector),
                                :source_signature,
                                :updated_at
                            )
                            ON CONFLICT (domain, path) DO UPDATE SET
                                node_uuid = EXCLUDED.node_uuid,
                                memory_id = EXCLUDED.memory_id,
                                uri = EXCLUDED.uri,
                                name = EXCLUDED.name,
                                priority = EXCLUDED.priority,
                                disclosure = EXCLUDED.disclosure,
                                glossary_json = EXCLUDED.glossary_json,
                                cue_text = EXCLUDED.cue_text,
                                body_preview = EXCLUDED.body_preview,
                                embedding_text = EXCLUDED.embedding_text,
                                embedding_model = EXCLUDED.embedding_model,
                                embedding_dim = EXCLUDED.embedding_dim,
                                embedding_vector = EXCLUDED.embedding_vector,
                                source_signature = EXCLUDED.source_signature,
                                updated_at = EXCLUDED.updated_at
                            """
                        ),
                        {
                            "domain": doc["domain"],
                            "path": doc["path"],
                            "node_uuid": doc["node_uuid"],
                            "memory_id": doc["memory_id"],
                            "uri": doc["uri"],
                            "name": doc["name"],
                            "priority": doc["priority"],
                            "disclosure": doc["disclosure"],
                            "glossary_json": json.dumps(doc["glossary_keywords"], ensure_ascii=False),
                            "cue_text": doc["cue_text"],
                            "body_preview": doc["body_preview"],
                            "embedding_text": doc["embedding_text"],
                            "embedding_model": embedding.model,
                            "embedding_dim": len(vector),
                            "embedding_vector": vector_literal(vector),
                            "source_signature": doc["source_signature"],
                            "updated_at": datetime.utcnow(),
                        },
                    )

            stale_keys = set(existing_map) - set(source_map)
            deleted_count = 0
            if stale_keys:
                for domain, path in stale_keys:
                    result = await session.execute(
                        text(
                            "DELETE FROM recall_documents WHERE domain = :domain AND path = :path"
                        ),
                        {"domain": domain, "path": path},
                    )
                    deleted_count += result.rowcount or 0

            return {
                "source_count": len(source_docs),
                "updated_count": len(stale),
                "deleted_count": deleted_count,
            }

    def _exact_bonus(self, query: str, row: dict[str, Any]) -> tuple[float, list[str], list[str]]:
        q = query.casefold()
        bonus = 0.0
        reasons: list[str] = []
        cues: list[str] = []

        glossary_hits = [kw for kw in self._parse_glossary_json(row.get("glossary_json")) if kw.casefold() in q]
        if glossary_hits:
            bonus += min(0.18, 0.07 * len(glossary_hits))
            reasons.append("glossary")
            cues.extend(glossary_hits[:3])

        name = (row.get("name") or "").replace("_", " ").replace("-", " ")
        if name and name.casefold() in q:
            bonus += 0.08
            reasons.append("name")
            cues.append(row.get("name") or "")

        path_tokens = [x for x in re.split(r"[/_\-\s]+", row.get("path") or "") if len(x) >= 3]
        path_hits = [tok for tok in path_tokens if tok.casefold() in q]
        if path_hits:
            bonus += min(0.10, 0.03 * len(path_hits))
            reasons.append("path")
            cues.extend(path_hits[:3])

        disclosure_text = (row.get("disclosure") or "")
        overlap_terms = [tok for tok in _EXACT_DISCLOSURE_TOKENS if tok.casefold() in q and tok.casefold() in disclosure_text.casefold()]
        if overlap_terms:
            bonus += min(0.08, 0.02 * len(overlap_terms))
            reasons.append("disclosure")
            cues.extend(overlap_terms[:3])

        seen: set[str] = set()
        deduped_cues: list[str] = []
        for cue in cues:
            key = cue.casefold()
            if key in seen:
                continue
            seen.add(key)
            deduped_cues.append(cue)
        return bonus, reasons, deduped_cues[:3]

    @staticmethod
    def _default_boot_uris() -> set[str]:
        import os
        raw = os.getenv("CORE_MEMORY_URIS", "")
        return {item.strip() for item in raw.split(",") if item.strip()}

    async def record_read(
        self,
        session_id: str,
        uri: str,
        node_uuid: str,
        session_key: Optional[str] = None,
        source: str = "tool:get_node",
        session: Optional[AsyncSession] = None,
    ) -> dict[str, Any]:
        async with self._optional_session(session) as session:
            row = await session.get(SessionReadNode, {"session_id": session_id, "uri": uri})
            now = datetime.utcnow()
            if row is None:
                row = SessionReadNode(
                    session_id=session_id,
                    uri=uri,
                    node_uuid=node_uuid,
                    session_key=session_key,
                    source=source,
                    read_count=1,
                    first_read_at=now,
                    last_read_at=now,
                )
                session.add(row)
            else:
                row.node_uuid = node_uuid
                row.session_key = session_key or row.session_key
                row.source = source or row.source
                row.read_count = int(row.read_count or 0) + 1
                row.last_read_at = now
            return {"success": True, "session_id": session_id, "uri": uri, "read_count": row.read_count}

    async def clear_session_reads(self, session_id: str, session: Optional[AsyncSession] = None) -> dict[str, Any]:
        async with self._optional_session(session) as session:
            result = await session.execute(delete(SessionReadNode).where(SessionReadNode.session_id == session_id))
            return {"success": True, "session_id": session_id, "deleted": result.rowcount or 0}

    async def list_session_reads(self, session_id: str, session: Optional[AsyncSession] = None) -> list[dict[str, Any]]:
        async with self._optional_session(session) as session:
            rows = (
                await session.execute(
                    select(SessionReadNode)
                    .where(SessionReadNode.session_id == session_id)
                    .order_by(SessionReadNode.last_read_at.desc())
                )
            ).scalars().all()
            return [
                {
                    "session_id": row.session_id,
                    "session_key": row.session_key,
                    "uri": row.uri,
                    "node_uuid": row.node_uuid,
                    "source": row.source,
                    "read_count": row.read_count,
                    "last_read_at": row.last_read_at.isoformat() if row.last_read_at else None,
                }
                for row in rows
            ]

    async def recall(
        self,
        query: str,
        embedding: RecallEmbeddingConfig,
        *,
        limit: int = 12,
        min_score: float = 0.0,
        max_display_items: int = 3,
        min_display_score: float = 0.45,
        score_precision: int = 2,
        exclude_boot_from_results: bool = True,
        session_id: Optional[str] = None,
        read_node_display_mode: str = "soft",
        session: Optional[AsyncSession] = None,
    ) -> dict[str, Any]:
        async with self._optional_session(session) as session:
            index_stats = await self.ensure_index(embedding, session=session)
            q_emb = (await self._embed_texts(embedding, [query]))[0]
            query_vector = vector_literal(q_emb)
            candidate_limit = max(limit, max_display_items, 1) * 6

            rows = (
                await session.execute(
                    text(
                        """
                        SELECT
                            domain,
                            path,
                            uri,
                            name,
                            priority,
                            disclosure,
                            glossary_json,
                            cue_text,
                            1 - (embedding_vector <=> CAST(:query_vector AS vector)) AS cosine
                        FROM recall_documents
                        WHERE embedding_model = :embedding_model
                        ORDER BY embedding_vector <=> CAST(:query_vector AS vector),
                                 priority ASC,
                                 char_length(path) ASC
                        LIMIT :candidate_limit
                        """
                    ),
                    {
                        "query_vector": query_vector,
                        "embedding_model": embedding.model,
                        "candidate_limit": candidate_limit,
                    },
                )
            ).mappings().all()

            read_uris: set[str] = set()
            if session_id:
                read_uris = {
                    row.uri
                    for row in (
                        await session.execute(select(SessionReadNode.uri).where(SessionReadNode.session_id == session_id))
                    ).all()
                }
            boot_uris = self._default_boot_uris() if exclude_boot_from_results else set()

            ranked: list[dict[str, Any]] = []
            for row in rows:
                cosine = float(row.get("cosine") or 0.0)
                bonus, reasons, matched_cues = self._exact_bonus(query, row)
                score = cosine + bonus
                if score < min_score:
                    continue
                item = {
                    "uri": row["uri"],
                    "score": round(score, score_precision + 4),
                    "score_display": round(score, score_precision),
                    "cosine": round(cosine, 6),
                    "bonus": round(bonus, 6),
                    "reasons": reasons,
                    "cues": matched_cues or [cue.strip() for cue in str(row.get("cue_text") or "").split("·") if cue.strip()][:3],
                    "read": row["uri"] in read_uris,
                    "boot": row["uri"] in boot_uris,
                }
                ranked.append(item)

            ranked.sort(key=lambda x: (-x["score"], x["uri"]))
            candidates = ranked[: max(limit, max_display_items)]

            display: list[dict[str, Any]] = []
            suppressed = {"boot": 0, "read": 0, "score": 0}
            for item in candidates:
                if item["boot"]:
                    suppressed["boot"] += 1
                    continue
                if item["read"]:
                    strong_read_hit = item["bonus"] >= 0.08 or item["score"] >= max(min_display_score + 0.1, 0.62)
                    if read_node_display_mode == "hard":
                        suppressed["read"] += 1
                        continue
                    if read_node_display_mode == "soft" and not strong_read_hit:
                        suppressed["read"] += 1
                        continue
                if item["score"] < min_display_score:
                    suppressed["score"] += 1
                    continue
                display.append(item)
                if len(display) >= max_display_items:
                    break

            return {
                "query": query,
                "index": index_stats,
                "candidates": candidates,
                "items": display,
                "suppressed": suppressed,
                "boot_uris": sorted(boot_uris),
                "read_node_display_mode": read_node_display_mode,
            }
